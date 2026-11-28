from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

import pytest

from logix_agent.modules.messaging.models import OutboxEvent
from logix_agent.modules.messaging.outbox_relay import (
    AgentOutboxRelay,
    outbox_retry_delay_ms,
    serialize_outbox_envelope,
)
from logix_agent.modules.messaging.redactor import (
    REDACTED_PLACEHOLDER,
    redact_audit_value,
)


def test_redact_audit_value_strips_sensitive_keys_and_token_patterns() -> None:
    sample = {
        "orderId": "ord-1",
        "password": "secret-password",
        "nested": {
            "apiKey": "sk-1234567890abcdefghij",
            "authorization": "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature123456",
            "note": "Normal text",
            "leakedJwt": "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.abcdefghijklmno",
        },
        "items": [{"sku": "SKU-1", "refreshToken": "tok-abc"}],
    }

    redacted = redact_audit_value(sample)

    assert redacted["orderId"] == "ord-1"
    assert redacted["password"] == REDACTED_PLACEHOLDER
    assert redacted["nested"]["apiKey"] == REDACTED_PLACEHOLDER
    assert redacted["nested"]["authorization"] == REDACTED_PLACEHOLDER
    assert redacted["nested"]["note"] == "Normal text"
    assert redacted["nested"]["leakedJwt"] == REDACTED_PLACEHOLDER
    assert redacted["items"][0]["sku"] == "SKU-1"
    assert redacted["items"][0]["refreshToken"] == REDACTED_PLACEHOLDER


def test_serialize_outbox_envelope_matches_canonical_camel_case_contract() -> None:
    event_id = uuid4()
    tenant_id = uuid4()
    agg_id = uuid4()
    corr_id = uuid4()
    cause_id = uuid4()
    actor_id = str(uuid4())
    occurred_at = datetime(2026, 11, 24, 9, 30, 0, tzinfo=UTC)

    row = OutboxEvent(
        id=event_id,
        tenant_id=tenant_id,
        event_type="AgentToolCalled",
        event_version=1,
        aggregate_type="ToolCall",
        aggregate_id=agg_id,
        aggregate_version=2,
        correlation_id=corr_id,
        causation_id=cause_id,
        payload={
            "toolCallId": str(agg_id),
            "toolName": "list_orders",
            "outcome": "SUCCESS",
            "actorId": actor_id,
        },
        occurred_at=occurred_at,
        attempt_count=0,
    )

    envelope = serialize_outbox_envelope(row)

    assert envelope == {
        "eventId": str(event_id),
        "eventType": "AgentToolCalled",
        "eventVersion": 1,
        "occurredAt": "2026-11-24T09:30:00Z",
        "producer": "agent-service",
        "tenantId": str(tenant_id),
        "actorId": actor_id,
        "correlationId": str(corr_id),
        "causationId": str(cause_id),
        "aggregateType": "ToolCall",
        "aggregateId": str(agg_id),
        "aggregateVersion": 2,
        "payload": {
            "toolCallId": str(agg_id),
            "toolName": "list_orders",
            "outcome": "SUCCESS",
        },
    }


def test_outbox_retry_delay_ms_exponential_with_cap() -> None:
    assert outbox_retry_delay_ms(1, base_ms=1000, max_ms=10000) == 1000
    assert outbox_retry_delay_ms(2, base_ms=1000, max_ms=10000) == 2000
    assert outbox_retry_delay_ms(3, base_ms=1000, max_ms=10000) == 4000
    assert outbox_retry_delay_ms(10, base_ms=1000, max_ms=10000) == 10000


class _FakeProducer:
    def __init__(self, *, should_fail: bool = False) -> None:
        self.should_fail = should_fail
        self.sent: list[tuple[str, bytes, bytes | None]] = []

    async def start(self) -> None:
        return None

    async def stop(self) -> None:
        return None

    async def send_and_wait(self, topic: str, value: bytes, key: bytes | None = None) -> None:
        if self.should_fail:
            raise RuntimeError("Kafka broker unavailable")
        self.sent.append((topic, value, key))


class _FakeScalarResult:
    def __init__(self, rows: list[OutboxEvent]) -> None:
        self._rows = rows

    def all(self) -> list[OutboxEvent]:
        return self._rows


class _FakeSession:
    def __init__(self, rows: list[OutboxEvent]) -> None:
        self._rows = rows
        self.executed: list[Any] = []

    async def __aenter__(self) -> _FakeSession:
        return self

    async def __aexit__(self, *args: object) -> None:
        return None

    def begin(self) -> _FakeSession:
        return self

    async def scalars(self, _stmt: Any) -> _FakeScalarResult:
        return _FakeScalarResult(self._rows)

    async def execute(self, stmt: Any) -> None:
        self.executed.append(stmt)


@pytest.mark.asyncio
async def test_agent_outbox_relay_publishes_and_marks_published() -> None:
    row = OutboxEvent(
        id=uuid4(),
        tenant_id=uuid4(),
        event_type="AgentExecutionCompleted",
        event_version=1,
        aggregate_type="AgentExecution",
        aggregate_id=uuid4(),
        aggregate_version=2,
        correlation_id=uuid4(),
        causation_id=None,
        payload={
            "agentExecutionId": str(uuid4()),
            "toolsUsed": ["get_stock"],
            "success": True,
            "durationMs": 120,
            "actorId": str(uuid4()),
        },
        occurred_at=datetime.now(UTC),
        attempt_count=0,
    )
    session = _FakeSession([row])
    producer = _FakeProducer()
    relay = AgentOutboxRelay(
        lambda: session,  # type: ignore[arg-type]
        brokers="127.0.0.1:9092",
        client_id="agent-service",
        topic="logix.agent.events.v1",
        producer=producer,
    )

    published = await relay.process_batch()

    assert published == 1
    assert len(producer.sent) == 1
    topic, raw_value, key = producer.sent[0]
    assert topic == "logix.agent.events.v1"
    assert key == str(row.aggregate_id).encode("utf-8")
    decoded = json.loads(raw_value.decode("utf-8"))
    assert decoded["eventType"] == "AgentExecutionCompleted"
    assert decoded["producer"] == "agent-service"
    assert "actorId" not in decoded["payload"]
    assert len(session.executed) == 1


@pytest.mark.asyncio
async def test_agent_outbox_relay_schedules_retry_on_broker_failure() -> None:
    row = OutboxEvent(
        id=uuid4(),
        tenant_id=uuid4(),
        event_type="AgentToolCalled",
        event_version=1,
        aggregate_type="ToolCall",
        aggregate_id=uuid4(),
        aggregate_version=1,
        correlation_id=uuid4(),
        causation_id=None,
        payload={"toolName": "list_orders", "outcome": "SUCCESS"},
        occurred_at=datetime.now(UTC),
        attempt_count=0,
    )
    session = _FakeSession([row])
    producer = _FakeProducer(should_fail=True)
    relay = AgentOutboxRelay(
        lambda: session,  # type: ignore[arg-type]
        brokers="127.0.0.1:9092",
        client_id="agent-service",
        topic="logix.agent.events.v1",
        producer=producer,
    )

    published = await relay.process_batch()

    assert published == 0
    assert len(session.executed) == 1
