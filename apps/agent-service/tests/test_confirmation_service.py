"""Unit tests for ConfirmationService and context hashing."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest

from logix_agent.modules.auth import Actor
from logix_agent.modules.confirmations.errors import (
    ConfirmationAccessDeniedError,
    ConfirmationExpiredError,
    ConfirmationNotFoundError,
    ConfirmationStateError,
)
from logix_agent.modules.confirmations.service import (
    ConfirmationService,
    InMemoryConfirmationStore,
    compute_context_hash,
)


def _actor(*, user_id: str = "u1", tenant_id: str = "t1", role: str = "MEMBER") -> Actor:
    return Actor(
        user_id=user_id,
        tenant_id=tenant_id,
        role=role,
        permissions=frozenset(),
        access_token="tok",
    )


def test_context_hash_is_deterministic_and_sensitive_to_version():
    target_id = uuid.uuid4()
    args1 = {"order_id": str(target_id), "note": "urgent"}
    args2 = {"note": "urgent", "order_id": str(target_id)}  # different key order

    h1 = compute_context_hash("t1", "u1", "confirm_order", "sales_order", target_id, 1, args1)
    h2 = compute_context_hash("t1", "u1", "confirm_order", "sales_order", target_id, 1, args2)
    assert h1 == h2

    # Different version produces different hash
    h3 = compute_context_hash("t1", "u1", "confirm_order", "sales_order", target_id, 2, args1)
    assert h1 != h3


async def test_create_and_approve_confirmation():
    svc = ConfirmationService(InMemoryConfirmationStore())
    tenant_id = str(uuid.uuid4())
    user_id = str(uuid.uuid4())
    target_id = str(uuid.uuid4())
    expires = datetime.now(UTC) + timedelta(minutes=15)

    rec = await svc.create_request(
        tenant_id=tenant_id,
        user_id=user_id,
        agent_execution_id=uuid.uuid4(),
        tool_call_id=uuid.uuid4(),
        action_type="confirm_order",
        target_type="sales_order",
        target_id=target_id,
        expected_target_version=1,
        preview_summary={"totalAmount": 500},
        arguments={"order_id": target_id},
        expires_at=expires,
    )
    assert rec.status == "PENDING"
    assert rec.expected_target_version == 1

    # Approve
    actor = _actor(user_id=user_id, tenant_id=tenant_id)
    approved = await svc.record_decision(
        tenant_id=tenant_id,
        approval_id=rec.id,
        actor=actor,
        decision="APPROVE",
    )
    assert approved.status == "CONFIRMED"
    assert approved.confirmed_at is not None

    # Cannot approve again (replay protection)
    with pytest.raises(ConfirmationStateError):
        await svc.record_decision(
            tenant_id=tenant_id,
            approval_id=rec.id,
            actor=actor,
            decision="APPROVE",
        )

    # Mark consumed
    consumed = await svc.mark_consumed(tenant_id, rec.id)
    assert consumed.status == "CONSUMED"
    assert consumed.consumed_at is not None


async def test_reject_confirmation():
    svc = ConfirmationService(InMemoryConfirmationStore())
    tenant_id = str(uuid.uuid4())
    user_id = str(uuid.uuid4())
    target_id = str(uuid.uuid4())

    rec = await svc.create_request(
        tenant_id=tenant_id,
        user_id=user_id,
        agent_execution_id=uuid.uuid4(),
        tool_call_id=uuid.uuid4(),
        action_type="confirm_order",
        target_type="sales_order",
        target_id=target_id,
        expected_target_version=1,
        preview_summary={},
        arguments={},
        expires_at=datetime.now(UTC) + timedelta(minutes=15),
    )

    actor = _actor(user_id=user_id, tenant_id=tenant_id)
    rejected = await svc.record_decision(
        tenant_id=tenant_id,
        approval_id=rec.id,
        actor=actor,
        decision="REJECT",
        reason="Price is wrong",
    )
    assert rejected.status == "REJECTED"


async def test_cross_tenant_access_is_not_found():
    svc = ConfirmationService(InMemoryConfirmationStore())
    t1 = str(uuid.uuid4())
    t2 = str(uuid.uuid4())
    u1 = str(uuid.uuid4())

    rec = await svc.create_request(
        tenant_id=t1,
        user_id=u1,
        agent_execution_id=uuid.uuid4(),
        tool_call_id=uuid.uuid4(),
        action_type="confirm_order",
        target_type="sales_order",
        target_id=uuid.uuid4(),
        expected_target_version=1,
        preview_summary={},
        arguments={},
        expires_at=datetime.now(UTC) + timedelta(minutes=15),
    )

    # Actor from t2 attempts to decide
    actor_t2 = _actor(user_id=u1, tenant_id=t2)
    with pytest.raises(ConfirmationNotFoundError):
        await svc.record_decision(
            tenant_id=t2,
            approval_id=rec.id,
            actor=actor_t2,
            decision="APPROVE",
        )


async def test_different_user_cannot_approve_unless_owner():
    svc = ConfirmationService(InMemoryConfirmationStore())
    t1 = str(uuid.uuid4())
    creator = str(uuid.uuid4())
    other_member = str(uuid.uuid4())
    owner = str(uuid.uuid4())

    rec = await svc.create_request(
        tenant_id=t1,
        user_id=creator,
        agent_execution_id=uuid.uuid4(),
        tool_call_id=uuid.uuid4(),
        action_type="confirm_order",
        target_type="sales_order",
        target_id=uuid.uuid4(),
        expected_target_version=1,
        preview_summary={},
        arguments={},
        expires_at=datetime.now(UTC) + timedelta(minutes=15),
    )

    # Other non-owner member is denied
    with pytest.raises(ConfirmationAccessDeniedError):
        await svc.record_decision(
            tenant_id=t1,
            approval_id=rec.id,
            actor=_actor(user_id=other_member, tenant_id=t1, role="MEMBER"),
            decision="APPROVE",
        )

    # Owner is allowed
    approved = await svc.record_decision(
        tenant_id=t1,
        approval_id=rec.id,
        actor=_actor(user_id=owner, tenant_id=t1, role="OWNER"),
        decision="APPROVE",
    )
    assert approved.status == "CONFIRMED"


async def test_expired_confirmation_cannot_be_decided():
    svc = ConfirmationService(InMemoryConfirmationStore())
    t1 = str(uuid.uuid4())
    u1 = str(uuid.uuid4())
    expired_time = datetime.now(UTC) - timedelta(minutes=1)

    rec = await svc.create_request(
        tenant_id=t1,
        user_id=u1,
        agent_execution_id=uuid.uuid4(),
        tool_call_id=uuid.uuid4(),
        action_type="confirm_order",
        target_type="sales_order",
        target_id=uuid.uuid4(),
        expected_target_version=1,
        preview_summary={},
        arguments={},
        expires_at=expired_time,
    )

    actor = _actor(user_id=u1, tenant_id=t1)
    with pytest.raises(ConfirmationExpiredError):
        await svc.record_decision(
            tenant_id=t1,
            approval_id=rec.id,
            actor=actor,
            decision="APPROVE",
        )

    # Check that status was marked EXPIRED
    updated = await svc.get_request(t1, rec.id)
    assert updated is not None
    assert updated.status == "EXPIRED"
