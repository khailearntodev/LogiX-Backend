"""AG-UI chat endpoint: auth, thread ownership, event stream and error mapping."""

from __future__ import annotations

import json
import time
import uuid
from collections.abc import Iterator

import jwt
import pytest
from httpx import ASGITransport, AsyncClient

from logix_agent.config import settings
from logix_agent.main import app
from logix_agent.modules.agui.router import build_agui_runtime
from logix_agent.modules.ai.adapters.fake_gateway import FakeModelGateway
from logix_agent.modules.ai.errors import ModelTimeoutError
from logix_agent.modules.ai.ports import ModelGateway

SECRET = "test-secret"


def _token(*, user: str = "user-1", tenant: str | None = "tenant-1", exp: int = 300) -> str:
    payload: dict[str, object] = {"sub": user, "exp": int(time.time()) + exp}
    if tenant is not None:
        payload["tenantId"] = tenant
    return jwt.encode(payload, SECRET, algorithm="HS256")


def _install(gateway: ModelGateway) -> None:
    app.state.agui_runtime = build_agui_runtime(gateway)


@pytest.fixture(autouse=True)
def _auth_secret(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setattr(settings, "jwt_secret", SECRET)
    yield
    app.state.agui_runtime = None


def _body(thread_id: str, *texts: str, **extra: object) -> dict[str, object]:
    return {
        "threadId": thread_id,
        "runId": str(uuid.uuid4()),
        "state": {},
        "messages": [
            {"id": str(uuid.uuid4()), "role": "user", "content": text}
            for text in texts
        ],
        "tools": [],
        "context": [],
        "forwardedProps": {},
        **extra,
    }


def _events(text: str) -> list[dict]:
    return [
        json.loads(line[len("data:") :].strip())
        for line in text.splitlines()
        if line.startswith("data:")
    ]


async def _run(
    body: dict[str, object], token: str | None = None
) -> tuple[int, list[dict], dict]:
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post("/api/v1/agent/runs", json=body, headers=headers)
    if response.headers.get("content-type", "").startswith("text/event-stream"):
        return response.status_code, _events(response.text), {}
    return response.status_code, [], response.json()


async def test_missing_token_is_rejected() -> None:
    _install(FakeModelGateway.echo())
    status, _, error = await _run(_body("thread-aaaa1111", "hi"))
    assert status == 401
    assert error["statusCode"] == 401 and error["error"] == "Unauthorized"


async def test_token_without_tenant_is_rejected() -> None:
    _install(FakeModelGateway.echo())
    status, _, _ = await _run(_body("thread-aaaa1111", "hi"), _token(tenant=None))
    assert status == 401


async def test_token_signed_with_other_secret_is_rejected() -> None:
    _install(FakeModelGateway.echo())
    forged = jwt.encode(
        {"sub": "u", "tenantId": "t", "exp": int(time.time()) + 60},
        "other",
        algorithm="HS256",
    )
    status, _, _ = await _run(_body("thread-aaaa1111", "hi"), forged)
    assert status == 401


async def test_unconfigured_secret_fails_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "jwt_secret", None)
    _install(FakeModelGateway.echo())
    status, _, _ = await _run(_body("thread-aaaa1111", "hi"), _token())
    assert status == 503


async def test_run_streams_agui_events_and_answer() -> None:
    gateway = FakeModelGateway.echo()
    _install(gateway)

    status, events, _ = await _run(_body("thread-aaaa1111", "hello"), _token())

    assert status == 200
    types = [e["type"] for e in events]
    assert types[0] == "RUN_STARTED"
    assert types[-1] == "RUN_FINISHED"
    assert "RUN_ERROR" not in types
    streamed = "".join(
        e["delta"] for e in events if e["type"] == "TEXT_MESSAGE_CONTENT"
    )
    assert streamed == "[fake] hello"


async def test_identity_comes_from_token_not_client_props() -> None:
    gateway = FakeModelGateway.echo()
    _install(gateway)
    body = _body(
        "thread-aaaa1111",
        "hello",
        forwardedProps={"tenant_id": "evil", "tenantId": "evil"},
        state={"tenant_id": "evil"},
    )

    await _run(body, _token(tenant="tenant-1"))

    request = gateway.requests[0]
    assert request.tenant_id == "tenant-1"
    assert request.messages[0]["role"] == "system"


async def test_second_turn_includes_previous_history() -> None:
    gateway = FakeModelGateway.echo()
    _install(gateway)
    token = _token()

    await _run(_body("thread-aaaa1111", "first"), token)
    await _run(_body("thread-aaaa1111", "second"), token)

    roles = [m["role"] for m in gateway.requests[-1].messages]
    contents = [m["content"] for m in gateway.requests[-1].messages]
    assert roles[0] == "system"
    assert "first" in contents
    assert "[fake] first" in contents
    assert contents[-1] == "second"


async def test_client_echoing_full_history_does_not_duplicate_messages() -> None:
    gateway = FakeModelGateway.echo()
    _install(gateway)
    token = _token()

    _, first_events, _ = await _run(_body("thread-aaaa1111", "first"), token)
    history = [e for e in first_events if e["type"] == "MESSAGES_SNAPSHOT"][-1]["messages"]
    follow_up = _body("thread-aaaa1111", "second")
    follow_up["messages"] = [*history, *follow_up["messages"]]  # type: ignore[misc]

    await _run(follow_up, token)

    contents = [m["content"] for m in gateway.requests[-1].messages]
    assert contents.count("first") == 1
    assert contents.count("[fake] first") == 1
    assert contents[-1] == "second"


@pytest.mark.parametrize(
    ("user", "tenant"), [("user-2", "tenant-1"), ("user-1", "tenant-2")]
)
async def test_thread_of_another_actor_is_not_found(user: str, tenant: str) -> None:
    _install(FakeModelGateway.echo())
    await _run(_body("thread-aaaa1111", "mine"), _token(user="user-1", tenant="tenant-1"))

    status, _, error = await _run(
        _body("thread-aaaa1111", "steal"), _token(user=user, tenant=tenant)
    )

    assert status == 404
    assert error["statusCode"] == 404


async def test_invalid_thread_id_is_rejected() -> None:
    _install(FakeModelGateway.echo())
    status, _, _ = await _run(_body("bad id!", "hi"), _token())
    assert status == 422


async def test_gateway_timeout_becomes_coded_run_error() -> None:
    _install(FakeModelGateway.with_error(ModelTimeoutError("provider-secret-detail")))

    status, events, _ = await _run(_body("thread-aaaa1111", "hi"), _token())

    assert status == 200
    error = events[-1]
    assert error["type"] == "RUN_ERROR"
    assert error["code"] == "MODEL_TIMEOUT"
    assert "provider-secret-detail" not in json.dumps(events)


async def test_unexpected_failure_is_masked() -> None:
    def boom(*_: object) -> None:
        raise RuntimeError("db password is hunter2")

    _install(FakeModelGateway(response_factory=boom))  # type: ignore[arg-type]

    _, events, _ = await _run(_body("thread-aaaa1111", "hi"), _token())

    error = events[-1]
    assert error["type"] == "RUN_ERROR"
    assert error["code"] == "INTERNAL"
    assert "hunter2" not in json.dumps(events)
