"""Tests for thread listing, soft deletion and plain-text message recording."""

from __future__ import annotations

import time
import uuid
from collections.abc import Iterator

import jwt
import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.dialects import postgresql

from logix_agent.config import settings
from logix_agent.main import app
from logix_agent.modules.agui.router import build_agui_runtime
from logix_agent.modules.ai.adapters.fake_gateway import FakeModelGateway
from logix_agent.modules.conversations.models import Conversation, ConversationMessage

SECRET = "test-secret"


def _token(*, user: str = "user-1", tenant: str | None = "tenant-1", exp: int = 300) -> str:
    payload: dict[str, object] = {"sub": user, "exp": int(time.time()) + exp}
    if tenant is not None:
        payload["tenantId"] = tenant
    return jwt.encode(payload, SECRET, algorithm="HS256")


@pytest.fixture(autouse=True)
def _runtime_fixture(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setattr(settings, "jwt_secret", SECRET)
    app.state.agui_runtime = build_agui_runtime(FakeModelGateway.echo())
    yield
    app.state.agui_runtime = None


def _run_payload(thread_id: str, *texts: str, ids: list[str] | None = None) -> dict[str, object]:
    msg_ids = ids or [str(uuid.uuid4()) for _ in texts]
    return {
        "threadId": thread_id,
        "runId": str(uuid.uuid4()),
        "state": {},
        "messages": [
            {"id": mid, "role": "user", "content": text}
            for mid, text in zip(msg_ids, texts, strict=True)
        ],
        "tools": [],
        "context": [],
        "forwardedProps": {},
    }


async def test_threads_require_authentication() -> None:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res_list = await client.get("/api/v1/agent/threads")
        res_del = await client.delete("/api/v1/agent/threads/thread-11112222")
        res_msgs = await client.get("/api/v1/agent/threads/thread-11112222/messages")
    assert res_list.status_code == 401
    assert res_del.status_code == 401
    assert res_msgs.status_code == 401


async def test_runs_populate_threads_title_and_messages_with_dedup() -> None:
    token = _token()
    headers = {"Authorization": f"Bearer {token}"}
    first_msg_id = str(uuid.uuid4())
    second_msg_id = str(uuid.uuid4())
    transport = ASGITransport(app=app)

    async with AsyncClient(transport=transport, base_url="http://test") as client:
        r1 = await client.post(
            "/api/v1/agent/runs",
            json=_run_payload(
                "logix_thread_alpha11",
                "   Kiểm tra   tồn kho   hôm nay   ",
                ids=[first_msg_id],
            ),
            headers=headers,
        )
        assert r1.status_code == 200

        # Second turn echoes previous user message id and appends a new user message.
        r2 = await client.post(
            "/api/v1/agent/runs",
            json={
                "threadId": "logix_thread_alpha11",
                "runId": str(uuid.uuid4()),
                "state": {},
                "messages": [
                    {"id": first_msg_id, "role": "user", "content": "Kiểm tra tồn kho hôm nay"},
                    {"id": second_msg_id, "role": "user", "content": "Chi tiết kho HCM"},
                ],
                "tools": [],
                "context": [],
                "forwardedProps": {},
            },
            headers=headers,
        )
        assert r2.status_code == 200

        threads_res = await client.get("/api/v1/agent/threads", headers=headers)
        assert threads_res.status_code == 200
        threads = threads_res.json()
        assert len(threads) == 1
        assert threads[0]["threadId"] == "logix_thread_alpha11"
        assert threads[0]["title"] == "Kiểm tra tồn kho hôm nay"

        msgs_res = await client.get(
            "/api/v1/agent/threads/logix_thread_alpha11/messages",
            headers=headers,
        )
        assert msgs_res.status_code == 200
        msgs = msgs_res.json()
        assert [m["role"] for m in msgs] == ["USER", "ASSISTANT", "USER", "ASSISTANT"]
        assert msgs[0]["content"].strip() == "Kiểm tra   tồn kho   hôm nay"
        assert "[fake]" in msgs[1]["content"]
        assert msgs[2]["content"] == "Chi tiết kho HCM"


async def test_thread_isolation_across_users_and_tenants() -> None:
    h_u1_t1 = {"Authorization": f"Bearer {_token(user='user-1', tenant='tenant-1')}"}
    h_u2_t1 = {"Authorization": f"Bearer {_token(user='user-2', tenant='tenant-1')}"}
    h_u1_t2 = {"Authorization": f"Bearer {_token(user='user-1', tenant='tenant-2')}"}
    transport = ASGITransport(app=app)

    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post(
            "/api/v1/agent/runs",
            json=_run_payload("logix_thread_owner11", "bí mật công ty"),
            headers=h_u1_t1,
        )
        assert res.status_code == 200

        assert (await client.get("/api/v1/agent/threads", headers=h_u2_t1)).json() == []
        assert (await client.get("/api/v1/agent/threads", headers=h_u1_t2)).json() == []

        for other in (h_u2_t1, h_u1_t2):
            assert (
                await client.get(
                    "/api/v1/agent/threads/logix_thread_owner11/messages", headers=other
                )
            ).status_code == 404
            assert (
                await client.delete("/api/v1/agent/threads/logix_thread_owner11", headers=other)
            ).status_code == 404


async def test_delete_thread_soft_deletes_and_blocks_reuse() -> None:
    headers = {"Authorization": f"Bearer {_token()}"}
    transport = ASGITransport(app=app)

    async with AsyncClient(transport=transport, base_url="http://test") as client:
        await client.post(
            "/api/v1/agent/runs",
            json=_run_payload("logix_thread_todelete", "xin chào"),
            headers=headers,
        )
        await client.post(
            "/api/v1/agent/runs",
            json=_run_payload("logix_thread_keepme11", "giữ lại"),
            headers=headers,
        )

        del_res = await client.delete(
            "/api/v1/agent/threads/logix_thread_todelete", headers=headers
        )
        assert del_res.status_code == 200
        assert del_res.json() == {"threadId": "logix_thread_todelete", "deleted": True}

        threads = (await client.get("/api/v1/agent/threads", headers=headers)).json()
        assert [t["threadId"] for t in threads] == ["logix_thread_keepme11"]

        # Deleted thread cannot be fetched, deleted again, or reused.
        assert (
            await client.get(
                "/api/v1/agent/threads/logix_thread_todelete/messages", headers=headers
            )
        ).status_code == 404
        assert (
            await client.delete("/api/v1/agent/threads/logix_thread_todelete", headers=headers)
        ).status_code == 404
        assert (
            await client.post(
                "/api/v1/agent/runs",
                json=_run_payload("logix_thread_todelete", "cố dùng lại"),
                headers=headers,
            )
        ).status_code == 404

        assert (await client.delete("/api/v1/agent/threads/bad id!", headers=headers)).status_code == 422


def test_conversation_models_compile_cleanly_for_postgres() -> None:
    insert_sql = str(
        postgresql.insert(Conversation)
        .values(
            id=uuid.uuid4(),
            tenant_id=uuid.uuid4(),
            user_id=uuid.uuid4(),
            thread_id="logix_thread_12345678",
            status="ACTIVE",
        )
        .on_conflict_do_nothing()
        .compile(dialect=postgresql.dialect())
    )
    assert "INSERT INTO agent.conversations" in insert_sql
    assert "thread_id" in insert_sql
    assert "content_redacted" in ConversationMessage.__table__.c


async def test_conversation_recorder_persists_user_and_completed_assistant_buffer() -> None:
    from logix_agent.modules.auth import Actor
    from logix_agent.modules.conversations.recorder import ConversationRecorder
    from logix_agent.modules.conversations.service import InMemoryThreadStore

    store = InMemoryThreadStore()
    recorder = ConversationRecorder(store)
    actor = Actor(
        user_id="user-rec",
        tenant_id="tenant-rec",
        role="MEMBER",
        permissions=frozenset(),
        access_token="tok",
    )
    thread_id = "logix_recorder_01"
    await store.claim(thread_id, actor)

    await recorder.record_user_message(
        tenant_id=actor.tenant_id,
        thread_id=thread_id,
        messages=[
            {"id": "u-1", "role": "user", "content": [{"text": "Kiểm tra "}, {"text": "đơn hàng"}]}
        ],
    )

    buffer = recorder.new_assistant_buffer(fallback_message_id="exec-fallback")
    buffer.append_delta("   ", message_id="blank-msg")
    buffer.append_delta("Đơn hàng ", message_id="a-1")
    buffer.append_delta("đã giao.", message_id="a-1")
    await recorder.record_completed_assistant_message(
        tenant_id=actor.tenant_id,
        thread_id=thread_id,
        buffer=buffer,
    )

    saved = await store.list_messages(thread_id, actor)
    assert [(m.role, m.content, m.model_message_id) for m in saved] == [
        ("USER", "Kiểm tra \nđơn hàng", "u-1"),
        ("ASSISTANT", "Đơn hàng đã giao.", "a-1"),
    ]
