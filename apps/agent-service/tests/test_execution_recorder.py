"""Tests for execution / tool-call recording."""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy.dialects import postgresql

from logix_agent.modules.executions.ids import to_uuid
from logix_agent.modules.executions.service import (
    EXECUTION_FAILED,
    EXECUTION_RUNNING,
    TOOL_AWAITING_CONFIRMATION,
    TOOL_SUCCEEDED,
    InMemoryExecutionRecorder,
)


async def _execution(recorder: InMemoryExecutionRecorder, run_id: str = "run-1") -> uuid.UUID:
    return await recorder.ensure_execution(
        tenant_id="tenant-1",
        user_id="user-1",
        execution_id=run_id,
        thread_id="thread-12345",
        correlation_id="corr-1",
        prompt_policy_version="v1",
    )


async def _tool_call(recorder: InMemoryExecutionRecorder, run_id: str = "run-1") -> uuid.UUID:
    return await recorder.start_tool_call(
        tenant_id="tenant-1",
        execution_id=run_id,
        tool_name="confirm_order",
        tool_version="1",
        required_permission=None,
        risk_level="write",
        input_data={"order_id": uuid.uuid4()},  # not JSON-native on purpose
        target_service="order",
        status=TOOL_AWAITING_CONFIRMATION,
    )


def test_to_uuid_is_stable_for_non_uuid_strings():
    assert to_uuid("run-1") == to_uuid("run-1")
    assert to_uuid("run-1") != to_uuid("run-2")
    real = uuid.uuid4()
    assert to_uuid(str(real)) == real


async def test_ensure_execution_is_idempotent():
    recorder = InMemoryExecutionRecorder()
    first = await _execution(recorder)
    second = await _execution(recorder)
    assert first == second == to_uuid("run-1")
    assert len(recorder.executions) == 1


async def test_tool_calls_get_increasing_sequence_per_execution():
    recorder = InMemoryExecutionRecorder()
    await _execution(recorder, "run-1")
    await _execution(recorder, "run-2")
    a = await _tool_call(recorder, "run-1")
    b = await _tool_call(recorder, "run-1")
    c = await _tool_call(recorder, "run-2")
    sequences = {row.id: row.sequence for row in recorder.tool_calls.values()}
    assert (sequences[a], sequences[b], sequences[c]) == (1, 2, 1)


async def test_tool_call_requires_existing_execution():
    recorder = InMemoryExecutionRecorder()
    with pytest.raises(LookupError):
        await _tool_call(recorder)


async def test_tool_call_input_is_json_safe_and_outcome_recorded():
    recorder = InMemoryExecutionRecorder()
    await _execution(recorder)
    call_id = await _tool_call(recorder)
    row = recorder.tool_calls[(to_uuid("tenant-1"), call_id)]
    assert isinstance(row.input_data["order_id"], str)

    await recorder.finish_tool_call("tenant-1", call_id, TOOL_SUCCEEDED, latency_ms=12)
    assert row.status == TOOL_SUCCEEDED
    assert row.latency_ms == 12


async def test_terminal_status_sets_finished_at():
    recorder = InMemoryExecutionRecorder()
    await _execution(recorder)
    row = recorder.executions[(to_uuid("tenant-1"), to_uuid("run-1"))]
    assert row.status == EXECUTION_RUNNING and row.finished_at is None

    await recorder.set_execution_status("tenant-1", "run-1", EXECUTION_FAILED, error_code="X")
    assert row.status == EXECUTION_FAILED
    assert row.finished_at is not None


def test_sql_insert_is_conflict_safe_on_postgres():
    from sqlalchemy.dialects.postgresql import insert as pg_insert

    from logix_agent.modules.executions.models import AgentExecution

    stmt = (
        pg_insert(AgentExecution)
        .values(
            id=uuid.uuid4(),
            tenant_id=uuid.uuid4(),
            user_id=uuid.uuid4(),
            thread_id="thread-12345",
            agent_type="planner",
            status="RUNNING",
            prompt_policy_version="v1",
            correlation_id=uuid.uuid4(),
        )
        .on_conflict_do_nothing(index_elements=["id"])
    )
    sql = str(stmt.compile(dialect=postgresql.dialect()))
    assert "INSERT INTO agent.agent_executions" in sql
    assert "ON CONFLICT (id) DO NOTHING" in sql

