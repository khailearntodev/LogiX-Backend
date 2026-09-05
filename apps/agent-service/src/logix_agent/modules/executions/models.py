from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from uuid import UUID, uuid4

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKeyConstraint,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.ext.mutable import MutableDict
from sqlalchemy.orm import Mapped, mapped_column, relationship

from logix_agent.db.base import Base, SCHEMA, TenantMutableMixin


EMPTY_JSON = text("'{}'::jsonb")


class AgentExecution(TenantMutableMixin, Base):
    __tablename__ = "agent_executions"
    __table_args__ = (
        CheckConstraint(
            "status IN ('QUEUED', 'RUNNING', 'WAITING_TOOL', "
            "'WAITING_CONFIRMATION', 'SUCCEEDED', 'FAILED', 'CANCELED', 'TIMED_OUT')",
            name="agent_execution_status",
        ),
        CheckConstraint("latency_ms IS NULL OR latency_ms >= 0", name="execution_latency"),
        ForeignKeyConstraint(
            ["tenant_id", "conversation_id"],
            [f"{SCHEMA}.conversations.tenant_id", f"{SCHEMA}.conversations.id"],
            name="fk_executions_tenant_conversation",
            ondelete="RESTRICT",
        ),
        UniqueConstraint("tenant_id", "id", name="uq_agent_executions_tenant_id"),
        Index(
            "ux_agent_execution_idempotency",
            "tenant_id",
            "user_id",
            "idempotency_key",
            unique=True,
            postgresql_where=text("idempotency_key IS NOT NULL"),
        ),
        Index(
            "ix_agent_execution_user_recent",
            "tenant_id",
            "user_id",
            text("created_at DESC"),
        ),
        Index(
            "ix_agent_execution_status_age",
            "tenant_id",
            "status",
            "created_at",
            postgresql_where=text(
                "status IN ('QUEUED', 'RUNNING', 'WAITING_TOOL', "
                "'WAITING_CONFIRMATION') AND deleted_at IS NULL"
            ),
        ),
        Index(
            "ix_agent_execution_metrics",
            "tenant_id",
            "provider",
            "model",
            text("finished_at DESC"),
            postgresql_where=text("finished_at IS NOT NULL"),
        ),
        Index("ix_agent_execution_correlation", "tenant_id", "correlation_id"),
        {"schema": SCHEMA},
    )

    user_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), nullable=False)
    conversation_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), nullable=True
    )
    thread_id: Mapped[str] = mapped_column(String(200), nullable=False)
    agent_type: Mapped[str] = mapped_column(String(100), nullable=False)
    status: Mapped[str] = mapped_column(
        String(30), nullable=False, server_default=text("'QUEUED'")
    )
    intent: Mapped[dict[str, object]] = mapped_column(
        MutableDict.as_mutable(JSONB), nullable=False, default=dict, server_default=EMPTY_JSON
    )
    provider: Mapped[str | None] = mapped_column(String(100), nullable=True)
    model: Mapped[str | None] = mapped_column(String(200), nullable=True)
    model_version: Mapped[str | None] = mapped_column(String(100), nullable=True)
    prompt_policy_version: Mapped[str] = mapped_column(String(100), nullable=False)
    input_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    output_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    correlation_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), nullable=False)
    idempotency_key: Mapped[str | None] = mapped_column(String(100), nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    finished_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    latency_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    error_code: Mapped[str | None] = mapped_column(String(100), nullable=True)
    error_message_sanitized: Mapped[str | None] = mapped_column(Text, nullable=True)

    conversation: Mapped[Conversation | None] = relationship(back_populates="executions")
    model_calls: Mapped[list[AgentModelCall]] = relationship(back_populates="execution")
    tool_calls: Mapped[list[ToolCall]] = relationship(back_populates="execution")
    confirmations: Mapped[list[ConfirmationRequest]] = relationship(
        back_populates="execution", overlaps="confirmations,tool_call"
    )

class AgentModelCall(TenantMutableMixin, Base):
    __tablename__ = "agent_model_calls"
    __table_args__ = (
        CheckConstraint("sequence > 0", name="model_call_sequence_positive"),
        CheckConstraint("attempt_count > 0", name="model_call_attempt_positive"),
        CheckConstraint("input_tokens IS NULL OR input_tokens >= 0", name="input_tokens"),
        CheckConstraint(
            "output_tokens IS NULL OR output_tokens >= 0", name="output_tokens"
        ),
        CheckConstraint("latency_ms IS NULL OR latency_ms >= 0", name="model_latency"),
        ForeignKeyConstraint(
            ["tenant_id", "agent_execution_id"],
            [f"{SCHEMA}.agent_executions.tenant_id", f"{SCHEMA}.agent_executions.id"],
            name="fk_model_calls_tenant_execution",
            ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["tenant_id", "fallback_from_call_id"],
            [f"{SCHEMA}.agent_model_calls.tenant_id", f"{SCHEMA}.agent_model_calls.id"],
            name="fk_model_calls_fallback",
            ondelete="RESTRICT",
        ),
        UniqueConstraint("tenant_id", "id", name="uq_agent_model_calls_tenant_id"),
        UniqueConstraint(
            "tenant_id", "agent_execution_id", "sequence", name="ux_model_call_sequence"
        ),
        Index(
            "ix_model_call_metrics",
            "tenant_id",
            "provider",
            "model",
            "status",
            text("created_at DESC"),
        ),
        {"schema": SCHEMA},
    )

    agent_execution_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), nullable=False)
    sequence: Mapped[int] = mapped_column(Integer, nullable=False)
    model_profile: Mapped[str] = mapped_column(String(100), nullable=False)
    gateway_backend: Mapped[str] = mapped_column(String(50), nullable=False)
    provider: Mapped[str] = mapped_column(String(100), nullable=False)
    model: Mapped[str] = mapped_column(String(200), nullable=False)
    model_version: Mapped[str | None] = mapped_column(String(100), nullable=True)
    prompt_policy_version: Mapped[str] = mapped_column(String(100), nullable=False)
    attempt_count: Mapped[int] = mapped_column(
        Integer, nullable=False, default=1, server_default=text("1")
    )
    fallback_from_call_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), nullable=True
    )
    input_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    output_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    cost_amount: Mapped[Decimal | None] = mapped_column(Numeric(18, 6), nullable=True)
    latency_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    status: Mapped[str] = mapped_column(String(30), nullable=False)
    error_code: Mapped[str | None] = mapped_column(String(100), nullable=True)
    provider_request_id: Mapped[str | None] = mapped_column(String(200), nullable=True)

    execution: Mapped[AgentExecution] = relationship(back_populates="model_calls")

