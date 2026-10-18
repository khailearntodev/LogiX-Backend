"""Confirmation service managing sensitive tool approvals, context hash, and state machine."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Protocol
from uuid import NAMESPACE_DNS, UUID, uuid4, uuid5

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from logix_agent.modules.auth import Actor
from logix_agent.modules.confirmations.errors import (
    ConfirmationAccessDeniedError,
    ConfirmationExpiredError,
    ConfirmationNotFoundError,
    ConfirmationStateError,
)
from logix_agent.modules.confirmations.models import ConfirmationRequest


def _now() -> datetime:
    return datetime.now(UTC)


def _to_uuid(val: str | UUID) -> UUID:
    if isinstance(val, UUID):
        return val
    try:
        return UUID(str(val))
    except (ValueError, TypeError, AttributeError):
        return uuid5(NAMESPACE_DNS, str(val))


def compute_context_hash(
    tenant_id: str | UUID,
    user_id: str | UUID,
    action_type: str,
    target_type: str,
    target_id: str | UUID,
    target_version: int,
    arguments: dict[str, Any],
) -> str:
    """Deterministic SHA-256 hash preventing replay or parameter tampering."""
    serialized_args = json.dumps(arguments, sort_keys=True, default=str)
    raw = f"{tenant_id}:{user_id}:{action_type}:{target_type}:{target_id}:{target_version}:{serialized_args}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


@dataclass
class ConfirmationRecord:
    id: UUID
    tenant_id: UUID
    user_id: UUID
    agent_execution_id: UUID
    tool_call_id: UUID
    action_type: str
    target_type: str
    target_id: UUID
    expected_target_version: int
    preview_payload_sanitized: dict[str, Any]
    context_hash: str
    status: str
    expires_at: datetime
    confirmed_at: datetime | None = None
    consumed_at: datetime | None = None
    decision_at: datetime | None = None


class ConfirmationStore(Protocol):
    async def save(self, record: ConfirmationRecord) -> ConfirmationRecord: ...
    async def get(self, tenant_id: UUID, approval_id: UUID) -> ConfirmationRecord | None: ...
    async def update(self, record: ConfirmationRecord) -> ConfirmationRecord: ...


class InMemoryConfirmationStore:
    def __init__(self) -> None:
        self._records: dict[tuple[UUID, UUID], ConfirmationRecord] = {}

    async def save(self, record: ConfirmationRecord) -> ConfirmationRecord:
        self._records[(record.tenant_id, record.id)] = record
        return record

    async def get(self, tenant_id: UUID, approval_id: UUID) -> ConfirmationRecord | None:
        return self._records.get((tenant_id, approval_id))

    async def update(self, record: ConfirmationRecord) -> ConfirmationRecord:
        self._records[(record.tenant_id, record.id)] = record
        return record


class SqlAlchemyConfirmationStore:
    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._session_factory = session_factory

    async def save(self, record: ConfirmationRecord) -> ConfirmationRecord:
        model = ConfirmationRequest(
            id=record.id,
            tenant_id=record.tenant_id,
            user_id=record.user_id,
            agent_execution_id=record.agent_execution_id,
            tool_call_id=record.tool_call_id,
            action_type=record.action_type,
            target_type=record.target_type,
            target_id=record.target_id,
            expected_target_version=record.expected_target_version,
            preview_payload_sanitized=record.preview_payload_sanitized,
            context_hash=record.context_hash,
            status=record.status,
            expires_at=record.expires_at,
            confirmed_at=record.confirmed_at,
            consumed_at=record.consumed_at,
            decision_at=record.decision_at,
        )
        async with self._session_factory() as session:
            session.add(model)
            await session.commit()
        return record

    async def get(self, tenant_id: UUID, approval_id: UUID) -> ConfirmationRecord | None:
        stmt = select(ConfirmationRequest).where(
            ConfirmationRequest.tenant_id == tenant_id,
            ConfirmationRequest.id == approval_id,
            ConfirmationRequest.deleted_at.is_(None),
        )
        async with self._session_factory() as session:
            res = await session.execute(stmt)
            model = res.scalar_one_or_none()
            if model is None:
                return None
            return ConfirmationRecord(
                id=model.id,
                tenant_id=model.tenant_id,
                user_id=model.user_id,
                agent_execution_id=model.agent_execution_id,
                tool_call_id=model.tool_call_id,
                action_type=model.action_type,
                target_type=model.target_type,
                target_id=model.target_id,
                expected_target_version=model.expected_target_version,
                preview_payload_sanitized=dict(model.preview_payload_sanitized),
                context_hash=model.context_hash,
                status=model.status,
                expires_at=model.expires_at,
                confirmed_at=model.confirmed_at,
                consumed_at=model.consumed_at,
                decision_at=model.decision_at,
            )

    async def update(self, record: ConfirmationRecord) -> ConfirmationRecord:
        stmt = (
            update(ConfirmationRequest)
            .where(
                ConfirmationRequest.tenant_id == record.tenant_id,
                ConfirmationRequest.id == record.id,
            )
            .values(
                status=record.status,
                confirmed_at=record.confirmed_at,
                consumed_at=record.consumed_at,
                decision_at=record.decision_at,
            )
        )
        async with self._session_factory() as session:
            await session.execute(stmt)
            await session.commit()
        return record


class ConfirmationService:
    def __init__(self, store: ConfirmationStore) -> None:
        self._store = store

    async def create_request(
        self,
        *,
        tenant_id: str | UUID,
        user_id: str | UUID,
        agent_execution_id: str | UUID,
        tool_call_id: str | UUID,
        action_type: str,
        target_type: str,
        target_id: str | UUID,
        expected_target_version: int,
        preview_summary: dict[str, Any],
        arguments: dict[str, Any],
        expires_at: datetime,
    ) -> ConfirmationRecord:
        t_uuid = _to_uuid(tenant_id)
        u_uuid = _to_uuid(user_id)
        exec_uuid = _to_uuid(agent_execution_id)
        tc_uuid = _to_uuid(tool_call_id)
        target_uuid = _to_uuid(target_id)

        chash = compute_context_hash(
            tenant_id=t_uuid,
            user_id=u_uuid,
            action_type=action_type,
            target_type=target_type,
            target_id=target_uuid,
            target_version=expected_target_version,
            arguments=arguments,
        )

        record = ConfirmationRecord(
            id=uuid4(),
            tenant_id=t_uuid,
            user_id=u_uuid,
            agent_execution_id=exec_uuid,
            tool_call_id=tc_uuid,
            action_type=action_type,
            target_type=target_type,
            target_id=target_uuid,
            expected_target_version=expected_target_version,
            preview_payload_sanitized=preview_summary,
            context_hash=chash,
            status="PENDING",
            expires_at=expires_at,
        )
        return await self._store.save(record)

    async def get_request(
        self, tenant_id: str | UUID, approval_id: str | UUID
    ) -> ConfirmationRecord | None:
        return await self._store.get(_to_uuid(tenant_id), _to_uuid(approval_id))

    async def record_decision(
        self,
        *,
        tenant_id: str | UUID,
        approval_id: str | UUID,
        actor: Actor,
        decision: str,  # "APPROVE" | "REJECT"
        reason: str | None = None,
    ) -> ConfirmationRecord:
        t_uuid = _to_uuid(tenant_id)
        a_uuid = _to_uuid(approval_id)
        record = await self._store.get(t_uuid, a_uuid)
        if record is None:
            raise ConfirmationNotFoundError(f"Confirmation request not found: {approval_id}")

        # Strict tenant check
        if record.tenant_id != _to_uuid(actor.tenant_id):
            raise ConfirmationNotFoundError(f"Confirmation request not found: {approval_id}")

        # Actor permission check: creator or OWNER
        if record.user_id != _to_uuid(actor.user_id) and actor.role != "OWNER":
            raise ConfirmationAccessDeniedError(
                "You do not have authority to make decisions on this confirmation"
            )

        now = _now()
        # Check expiration
        if now > record.expires_at:
            record.status = "EXPIRED"
            await self._store.update(record)
            raise ConfirmationExpiredError(f"Confirmation request {approval_id} has expired")

        # Check replay / state
        if record.status != "PENDING":
            raise ConfirmationStateError(
                f"Confirmation request is already {record.status}, cannot be decided again"
            )

        norm_decision = decision.strip().upper()
        record.decision_at = now
        if norm_decision == "APPROVE":
            record.status = "CONFIRMED"
            record.confirmed_at = now
        elif norm_decision == "REJECT":
            record.status = "REJECTED"
        else:
            raise ValueError(f"Unknown decision '{decision}'. Expected APPROVE or REJECT.")

        return await self._store.update(record)

    async def mark_consumed(
        self, tenant_id: str | UUID, approval_id: str | UUID
    ) -> ConfirmationRecord:
        t_uuid = _to_uuid(tenant_id)
        a_uuid = _to_uuid(approval_id)
        record = await self._store.get(t_uuid, a_uuid)
        if record is None:
            raise ConfirmationNotFoundError(f"Confirmation request not found: {approval_id}")
        record.status = "CONSUMED"
        record.consumed_at = _now()
        return await self._store.update(record)

    async def mark_stale(
        self, tenant_id: str | UUID, approval_id: str | UUID
    ) -> ConfirmationRecord:
        t_uuid = _to_uuid(tenant_id)
        a_uuid = _to_uuid(approval_id)
        record = await self._store.get(t_uuid, a_uuid)
        if record is None:
            raise ConfirmationNotFoundError(f"Confirmation request not found: {approval_id}")
        record.status = "REJECTED"
        return await self._store.update(record)
