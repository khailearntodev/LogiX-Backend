"""Tests for tenant-scoped Conversation Management Center RBAC, isolation, and redaction."""

from __future__ import annotations

from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from logix_agent.modules.auth import Actor, get_current_actor
from logix_agent.modules.conversations.admin_service import (
    CONVERSATION_MANAGE,
    CONVERSATION_READ,
    InMemoryConversationAdminService,
)
from logix_agent.modules.conversations.router import router as conversations_router
from logix_agent.modules.conversations.service import InMemoryThreadStore


def _make_actor(
    *,
    tenant_id: str,
    user_id: str | None = None,
    role: str = "MEMBER",
    permissions: frozenset[str] = frozenset(),
    is_super_admin: bool = False,
) -> Actor:
    return Actor(
        user_id=user_id or str(uuid4()),
        tenant_id=tenant_id,
        role=role,
        permissions=permissions,
        access_token="test-token",
        is_super_admin=is_super_admin,
    )


def _build_client(
    store: InMemoryThreadStore, current_actor: Actor
) -> TestClient:
    app = FastAPI()
    app.state.conversation_admin_service = InMemoryConversationAdminService(store)
    app.include_router(conversations_router)
    app.dependency_overrides[get_current_actor] = lambda: current_actor
    return TestClient(app)


@pytest.mark.asyncio
async def test_org_list_enforces_rbac_and_tenant_isolation() -> None:
    tenant_a = str(uuid4())
    tenant_b = str(uuid4())
    member_a = _make_actor(tenant_id=tenant_a, role="MEMBER")
    member_b = _make_actor(tenant_id=tenant_b, role="MEMBER")
    owner_a = _make_actor(
        tenant_id=tenant_a,
        role="OWNER",
        permissions=frozenset({CONVERSATION_READ, CONVERSATION_MANAGE}),
    )

    store = InMemoryThreadStore()
    thread_a = f"logix_thread_{uuid4()}"
    thread_b = f"logix_thread_{uuid4()}"
    await store.claim(thread_a, member_a)
    await store.record_message(
        tenant_id=tenant_a,
        thread_id=thread_a,
        role="USER",
        content="Kiểm tra tồn kho kho BD với Bearer secret_jwt_token_123",
    )
    await store.claim(thread_b, member_b)
    await store.record_message(
        tenant_id=tenant_b,
        thread_id=thread_b,
        role="USER",
        content="Tenant B private message",
    )

    # Member without permission cannot list org conversations (fail-closed 403)
    member_client = _build_client(store, member_a)
    res_forbidden = member_client.get("/api/v1/agent/conversations?scope=org")
    assert res_forbidden.status_code == 403

    # Owner with role=OWNER (even without explicit permission claim in older JWT) can access org conversations
    owner_role_only = _make_actor(tenant_id=tenant_a, role="OWNER", permissions=frozenset())
    assert _build_client(store, owner_role_only).get("/api/v1/agent/conversations?scope=org").status_code == 200

    # Owner with agent:conversation:read sees only tenant_a conversations
    owner_client = _build_client(store, owner_a)
    res_org = owner_client.get("/api/v1/agent/conversations?scope=org")
    assert res_org.status_code == 200
    body = res_org.json()
    assert body["total"] == 1
    assert body["items"][0]["threadId"] == thread_a
    assert body["items"][0]["userId"] == member_a.user_id

    # Owner in tenant_a cannot read tenant_b conversation
    res_cross = owner_client.get(f"/api/v1/agent/conversations/{thread_b}")
    assert res_cross.status_code == 404

    # Detail redacts Bearer tokens and marks isOwner=False for admin viewing member thread
    res_detail = owner_client.get(f"/api/v1/agent/conversations/{thread_a}")
    assert res_detail.status_code == 200
    detail = res_detail.json()
    assert detail["isOwner"] is False
    assert "secret_jwt_token_123" not in detail["messages"][0]["content"]
    assert "Bearer [REDACTED]" in detail["messages"][0]["content"]


@pytest.mark.asyncio
async def test_read_only_admin_cannot_modify_or_delete_other_users_conversation() -> None:
    tenant_id = str(uuid4())
    member = _make_actor(tenant_id=tenant_id, role="MEMBER")
    reader_only = _make_actor(
        tenant_id=tenant_id,
        role="ADMIN",
        permissions=frozenset({CONVERSATION_READ}),
    )
    manager = _make_actor(
        tenant_id=tenant_id,
        role="OWNER",
        permissions=frozenset({CONVERSATION_READ, CONVERSATION_MANAGE}),
    )

    store = InMemoryThreadStore()
    thread_id = f"logix_thread_{uuid4()}"
    await store.claim(thread_id, member)
    await store.record_message(
        tenant_id=tenant_id,
        thread_id=thread_id,
        role="USER",
        content="Hội thoại kiểm thử",
    )

    reader_client = _build_client(store, reader_only)
    assert reader_client.get(f"/api/v1/agent/conversations/{thread_id}").status_code == 200
    assert (
        reader_client.patch(
            f"/api/v1/agent/conversations/{thread_id}",
            json={"title": "Đổi tên trái phép"},
        ).status_code
        == 403
    )
    assert reader_client.delete(f"/api/v1/agent/conversations/{thread_id}").status_code == 403

    manager_client = _build_client(store, manager)
    res_patch = manager_client.patch(
        f"/api/v1/agent/conversations/{thread_id}",
        json={"title": "Hội thoại đã lưu trữ", "status": "ARCHIVED"},
    )
    assert res_patch.status_code == 200
    assert res_patch.json()["title"] == "Hội thoại đã lưu trữ"
    assert res_patch.json()["status"] == "ARCHIVED"

    res_del = manager_client.delete(f"/api/v1/agent/conversations/{thread_id}")
    assert res_del.status_code == 204
    assert manager_client.get(f"/api/v1/agent/conversations/{thread_id}").status_code == 404
