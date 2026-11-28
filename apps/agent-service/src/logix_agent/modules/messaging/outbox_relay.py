"""Background transactional outbox relay publishing Agent events to Kafka via aiokafka."""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from logix_agent.modules.messaging.models import OutboxEvent

logger = logging.getLogger(__name__)

AGENT_PRODUCER_ID = "agent-service"


class KafkaByteProducer(Protocol):
    async def start(self) -> None: ...
    async def stop(self) -> None: ...
    async def send_and_wait(
        self,
        topic: str,
        value: bytes,
        key: bytes | None = None,
    ) -> Any: ...


def outbox_retry_delay_ms(attempt_count: int, *, base_ms: int, max_ms: int) -> int:
    exponent = max(0, min(attempt_count - 1, 10))
    return min(max_ms, base_ms * (2**exponent))


def _iso_utc(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC).isoformat().replace("+00:00", "Z")


def serialize_outbox_envelope(row: OutboxEvent) -> dict[str, Any]:
    """Serialize an OutboxEvent row into the canonical camelCase DomainEventEnvelope."""
    raw_payload = dict(row.payload or {})
    actor_id_raw = raw_payload.pop("actorId", None)
    actor_id = actor_id_raw if isinstance(actor_id_raw, str) and actor_id_raw else None
    correlation_id = str(row.correlation_id)
    causation_id = str(row.causation_id) if row.causation_id is not None else correlation_id

    return {
        "eventId": str(row.id),
        "eventType": row.event_type,
        "eventVersion": int(row.event_version),
        "occurredAt": _iso_utc(row.occurred_at),
        "producer": AGENT_PRODUCER_ID,
        "tenantId": str(row.tenant_id),
        "actorId": actor_id,
        "correlationId": correlation_id,
        "causationId": causation_id,
        "aggregateType": row.aggregate_type,
        "aggregateId": str(row.aggregate_id),
        "aggregateVersion": int(row.aggregate_version),
        "payload": raw_payload,
    }


class AgentOutboxRelay:
    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        *,
        brokers: str,
        client_id: str,
        topic: str,
        interval_ms: int = 1000,
        batch_size: int = 20,
        retry_base_ms: int = 1000,
        retry_max_ms: int = 60000,
        request_timeout_ms: int = 3000,
        producer: KafkaByteProducer | None = None,
    ) -> None:
        if not brokers.strip() or not topic.strip():
            raise ValueError("Kafka brokers and topic are required for AgentOutboxRelay")
        self._session_factory = session_factory
        self._brokers = [b.strip() for b in brokers.split(",") if b.strip()]
        self._client_id = client_id
        self._topic = topic.strip()
        self._interval_seconds = max(0.1, interval_ms / 1000.0)
        self._batch_size = max(1, batch_size)
        self._retry_base_ms = max(100, retry_base_ms)
        self._retry_max_ms = max(self._retry_base_ms, retry_max_ms)
        self._request_timeout_ms = max(500, request_timeout_ms)
        self._producer: KafkaByteProducer | None = producer
        self._owns_producer = producer is None
        self._task: asyncio.Task[None] | None = None
        self._stop_event = asyncio.Event()

    async def start(self) -> None:
        if self._producer is None:
            from aiokafka import AIOKafkaProducer

            self._producer = AIOKafkaProducer(
                bootstrap_servers=self._brokers,
                client_id=self._client_id,
                request_timeout_ms=self._request_timeout_ms,
            )
        await self._producer.start()
        self._stop_event.clear()
        self._task = asyncio.create_task(self._run_loop(), name="agent-outbox-relay")
        logger.info(
            "AgentOutboxRelay started (topic=%s, brokers=%s)",
            self._topic,
            ",".join(self._brokers),
        )

    async def stop(self) -> None:
        self._stop_event.set()
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        if self._producer is not None and self._owns_producer:
            try:
                await self._producer.stop()
            except Exception as exc:
                logger.warning("AgentOutboxRelay producer stop warning: %s", exc)
            self._producer = None

    async def _run_loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                await self.process_batch()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("AgentOutboxRelay batch loop failed")
            try:
                await asyncio.wait_for(self._stop_event.wait(), timeout=self._interval_seconds)
            except TimeoutError:
                continue

    async def process_batch(self) -> int:
        if self._producer is None:
            raise RuntimeError("AgentOutboxRelay producer is not started")

        now = datetime.now(UTC)
        published_count = 0
        async with self._session_factory() as session:
            async with session.begin():
                stmt = (
                    select(OutboxEvent)
                    .where(
                        OutboxEvent.published_at.is_(None),
                        OutboxEvent.deleted_at.is_(None),
                        OutboxEvent.next_attempt_at <= now,
                    )
                    .order_by(OutboxEvent.occurred_at.asc(), OutboxEvent.id.asc())
                    .limit(self._batch_size)
                    .with_for_update(skip_locked=True)
                )
                rows = (await session.scalars(stmt)).all()
                for row in rows:
                    envelope = serialize_outbox_envelope(row)
                    encoded = json.dumps(envelope, separators=(",", ":")).encode("utf-8")
                    key = str(row.aggregate_id).encode("utf-8")
                    try:
                        await asyncio.wait_for(
                            self._producer.send_and_wait(self._topic, value=encoded, key=key),
                            timeout=self._request_timeout_ms / 1000.0,
                        )
                        await session.execute(
                            update(OutboxEvent)
                            .where(OutboxEvent.id == row.id)
                            .values(
                                published_at=datetime.now(UTC),
                                last_error=None,
                                version=OutboxEvent.version + 1,
                            )
                        )
                        published_count += 1
                    except Exception as exc:
                        next_attempt_count = int(row.attempt_count) + 1
                        delay_ms = outbox_retry_delay_ms(
                            next_attempt_count,
                            base_ms=self._retry_base_ms,
                            max_ms=self._retry_max_ms,
                        )
                        next_at = datetime.now(UTC) + timedelta(milliseconds=delay_ms)
                        await session.execute(
                            update(OutboxEvent)
                            .where(OutboxEvent.id == row.id)
                            .values(
                                attempt_count=next_attempt_count,
                                next_attempt_at=next_at,
                                last_error=str(exc)[:1000],
                                version=OutboxEvent.version + 1,
                            )
                        )
                        logger.error(
                            "AgentOutboxRelay publish failed (eventId=%s, attempt=%d); stopping batch early: %s",
                            row.id,
                            next_attempt_count,
                            exc,
                        )
                        break
        return published_count
