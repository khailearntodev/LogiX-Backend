"""Recording of agent executions and tool calls.

``confirmation_requests`` references ``agent_executions`` and ``tool_calls`` by
foreign key, so a real row must exist in both before a confirmation is created.
The recorder is the single place that creates and finishes those rows.

Two implementations share one protocol, mirroring ``ConfirmationStore``:
``InMemoryExecutionRecorder`` (development / tests) and
``SqlAlchemyExecutionRecorder`` (PostgreSQL).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Protocol
from uuid import UUID, uuid4

from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from logix_agent.modules.executions.ids import to_uuid
from logix_agent.modules.executions.models import AgentExecution
from logix_agent.modules.tools.models import ToolCall

AGENT_TYPE_PLANNER = "planner"

EXECUTION_RUNNING = "RUNNING"
EXECUTION_WAITING_CONFIRMATION = "WAITING_CONFIRMATION"
EXECUTION_SUCCEEDED = "SUCCEEDED"
EXECUTION_FAILED = "FAILED"
_TERMINAL_EXECUTION_STATUSES = frozenset({"SUCCEEDED", "FAILED", "CANCELED", "TIMED_OUT"})

TOOL_AWAITING_CONFIRMATION = "AWAITING_CONFIRMATION"
TOOL_SUCCEEDED = "SUCCEEDED"
TOOL_FAILED = "FAILED"
TOOL_REJECTED = "REJECTED"
TOOL_STALE = "STALE"

# ``tool_calls.required_permission`` is NOT NULL; this marks "authenticated user only".
NO_PERMISSION = "authenticated"


def _now() -> datetime:
    return datetime.now(UTC)


def _json_safe(data: dict[str, Any]) -> dict[str, Any]:
    """Round-trip through JSON so the JSONB column never receives non-serialisable values."""
    return json.loads(json.dumps(data, default=str))


class ExecutionRecorder(Protocol):
    async def ensure_execution(
        self,
        *,
        tenant_id: str | UUID,
        user_id: str | UUID,
        execution_id: str | UUID,
        thread_id: str,
        correlation_id: str,
        prompt_policy_version: str,
        agent_type: str = AGENT_TYPE_PLANNER,
    ) -> UUID:
        """Create the execution if absent (idempotent) and return its UUID."""
        ...

    async def set_execution_status(
        self,
        tenant_id: str | UUID,
        execution_id: str | UUID,
        status: str,
        *,
        error_code: str | None = None,
    ) -> None: ...

    async def start_tool_call(
        self,
        *,
        tenant_id: str | UUID,
        execution_id: str | UUID,
        tool_name: str,
        tool_version: str,
        required_permission: str | None,
        risk_level: str,
        input_data: dict[str, Any],
        target_service: str | None,
        status: str,
    ) -> UUID:
        """Record a tool call with the next sequence number and return its UUID."""
        ...

    async def finish_tool_call(
        self,
        tenant_id: str | UUID,
        tool_call_id: str | UUID,
        status: str,
        *,
        error_code: str | None = None,
        latency_ms: int | None = None,
    ) -> None: ...


@dataclass
class _ExecutionRow:
    id: UUID
    tenant_id: UUID
    user_id: UUID
    thread_id: str
    status: str
    error_code: str | None = None
    finished_at: datetime | None = None


@dataclass
class _ToolCallRow:
    id: UUID
    tenant_id: UUID
    agent_execution_id: UUID
    sequence: int
    tool_name: str
    status: str
    input_data: dict[str, Any] = field(default_factory=dict)
    error_code: str | None = None
    latency_ms: int | None = None


class InMemoryExecutionRecorder:
    def __init__(self) -> None:
        self.executions: dict[tuple[UUID, UUID], _ExecutionRow] = {}
        self.tool_calls: dict[tuple[UUID, UUID], _ToolCallRow] = {}

    async def ensure_execution(
        self,
        *,
        tenant_id: str | UUID,
        user_id: str | UUID,
        execution_id: str | UUID,
        thread_id: str,
        correlation_id: str,
        prompt_policy_version: str,
        agent_type: str = AGENT_TYPE_PLANNER,
    ) -> UUID:
        tenant, exec_id = to_uuid(tenant_id), to_uuid(execution_id)
        self.executions.setdefault(
            (tenant, exec_id),
            _ExecutionRow(
                id=exec_id,
                tenant_id=tenant,
                user_id=to_uuid(user_id),
                thread_id=thread_id,
                status=EXECUTION_RUNNING,
            ),
        )
        return exec_id

    async def set_execution_status(
        self,
        tenant_id: str | UUID,
        execution_id: str | UUID,
        status: str,
        *,
        error_code: str | None = None,
    ) -> None:
        row = self.executions.get((to_uuid(tenant_id), to_uuid(execution_id)))
        if row is None:
            return
        row.status = status
        row.error_code = error_code
        if status in _TERMINAL_EXECUTION_STATUSES:
            row.finished_at = _now()

    async def start_tool_call(
        self,
        *,
        tenant_id: str | UUID,
        execution_id: str | UUID,
        tool_name: str,
        tool_version: str,
        required_permission: str | None,
        risk_level: str,
        input_data: dict[str, Any],
        target_service: str | None,
        status: str,
    ) -> UUID:
        tenant, exec_id = to_uuid(tenant_id), to_uuid(execution_id)
        if (tenant, exec_id) not in self.executions:
            raise LookupError(f"Execution {exec_id} does not exist for this tenant")
        sequence = 1 + sum(
            1
            for row in self.tool_calls.values()
            if row.tenant_id == tenant and row.agent_execution_id == exec_id
        )
        row = _ToolCallRow(
            id=uuid4(),
            tenant_id=tenant,
            agent_execution_id=exec_id,
            sequence=sequence,
            tool_name=tool_name,
            status=status,
            input_data=_json_safe(input_data),
        )
        self.tool_calls[(tenant, row.id)] = row
        return row.id

    async def finish_tool_call(
        self,
        tenant_id: str | UUID,
        tool_call_id: str | UUID,
        status: str,
        *,
        error_code: str | None = None,
        latency_ms: int | None = None,
    ) -> None:
        row = self.tool_calls.get((to_uuid(tenant_id), to_uuid(tool_call_id)))
        if row is None:
            return
        row.status = status
        row.error_code = error_code
        row.latency_ms = latency_ms


class SqlAlchemyExecutionRecorder:
    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._session_factory = session_factory

    async def ensure_execution(
        self,
        *,
        tenant_id: str | UUID,
        user_id: str | UUID,
        execution_id: str | UUID,
        thread_id: str,
        correlation_id: str,
        prompt_policy_version: str,
        agent_type: str = AGENT_TYPE_PLANNER,
    ) -> UUID:
        exec_id = to_uuid(execution_id)
        stmt = (
            pg_insert(AgentExecution)
            .values(
                id=exec_id,
                tenant_id=to_uuid(tenant_id),
                user_id=to_uuid(user_id),
                thread_id=thread_id,
                agent_type=agent_type,
                status=EXECUTION_RUNNING,
                prompt_policy_version=prompt_policy_version,
                correlation_id=to_uuid(correlation_id),
                started_at=_now(),
            )
            .on_conflict_do_nothing(index_elements=["id"])
        )
        async with self._session_factory() as session:
            await session.execute(stmt)
            await session.commit()
        return exec_id

    async def set_execution_status(
        self,
        tenant_id: str | UUID,
        execution_id: str | UUID,
        status: str,
        *,
        error_code: str | None = None,
    ) -> None:
        values: dict[str, Any] = {
            "status": status,
            "error_code": error_code,
            "version": AgentExecution.version + 1,
        }
        if status in _TERMINAL_EXECUTION_STATUSES:
            values["finished_at"] = _now()
        stmt = (
            update(AgentExecution)
            .where(
                AgentExecution.tenant_id == to_uuid(tenant_id),
                AgentExecution.id == to_uuid(execution_id),
            )
            .values(**values)
        )
        async with self._session_factory() as session:
            await session.execute(stmt)
            await session.commit()

    async def start_tool_call(
        self,
        *,
        tenant_id: str | UUID,
        execution_id: str | UUID,
        tool_name: str,
        tool_version: str,
        required_permission: str | None,
        risk_level: str,
        input_data: dict[str, Any],
        target_service: str | None,
        status: str,
    ) -> UUID:
        tenant, exec_id = to_uuid(tenant_id), to_uuid(execution_id)
        async with self._session_factory() as session:
            next_sequence = await session.scalar(
                select(func.coalesce(func.max(ToolCall.sequence), 0) + 1).where(
                    ToolCall.tenant_id == tenant, ToolCall.agent_execution_id == exec_id
                )
            )
            row = ToolCall(
                id=uuid4(),
                tenant_id=tenant,
                agent_execution_id=exec_id,
                sequence=next_sequence,
                tool_name=tool_name,
                tool_version=tool_version,
                required_permission=required_permission or NO_PERMISSION,
                risk_level=risk_level,
                input_sanitized=_json_safe(input_data),
                status=status,
                started_at=_now(),
                target_service=target_service,
            )
            session.add(row)
            await session.commit()
            return row.id

    async def finish_tool_call(
        self,
        tenant_id: str | UUID,
        tool_call_id: str | UUID,
        status: str,
        *,
        error_code: str | None = None,
        latency_ms: int | None = None,
    ) -> None:
        stmt = (
            update(ToolCall)
            .where(
                ToolCall.tenant_id == to_uuid(tenant_id),
                ToolCall.id == to_uuid(tool_call_id),
            )
            .values(
                status=status,
                error_code=error_code,
                latency_ms=latency_ms,
                finished_at=_now(),
                version=ToolCall.version + 1,
            )
        )
        async with self._session_factory() as session:
            await session.execute(stmt)
            await session.commit()

