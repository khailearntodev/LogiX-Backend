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


class ToolCall(TenantMutableMixin, Base):
    __tablename__ = "tool_calls"
    __table_args__ = (
        CheckConstraint("sequence > 0", name="tool_call_sequence_positive"),
        CheckConstraint("attempt_count > 0", name="tool_attempt_positive"),
        CheckConstraint("latency_ms IS NULL OR latency_ms >= 0", name="tool_latency"),
        ForeignKeyConstraint(
            ["tenant_id", "agent_execution_id"],
            [f"{SCHEMA}.agent_executions.tenant_id", f"{SCHEMA}.agent_executions.id"],
            name="fk_tool_calls_tenant_execution",
            ondelete="RESTRICT",
        ),
        UniqueConstraint(
            "tenant_id", "agent_execution_id", "sequence", name="ux_tool_call_sequence"
        ),
        UniqueConstraint("tenant_id", "id", name="uq_tool_calls_tenant_id"),
        Index(
            "ux_tool_call_idempotency",
            "tenant_id",
            "agent_execution_id",
            "idempotency_key",
            unique=True,
            postgresql_where=text("idempotency_key IS NOT NULL"),
        ),
        Index(
            "ix_tool_call_metrics",
            "tenant_id",
            "tool_name",
            "status",
            text("finished_at DESC"),
        ),
        Index(
            "ix_tool_call_business_entity",
            "tenant_id",
            "business_entity_type",
            "business_entity_id",
        ),
        {"schema": SCHEMA},
    )

    agent_execution_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), nullable=False)
    sequence: Mapped[int] = mapped_column(Integer, nullable=False)
    tool_name: Mapped[str] = mapped_column(String(100), nullable=False)
    tool_version: Mapped[str] = mapped_column(String(50), nullable=False)
    required_permission: Mapped[str] = mapped_column(String(100), nullable=False)
    risk_level: Mapped[str] = mapped_column(String(30), nullable=False)
    input_sanitized: Mapped[dict[str, object]] = mapped_column(
        MutableDict.as_mutable(JSONB), nullable=False, default=dict, server_default=EMPTY_JSON
    )
    output_sanitized: Mapped[dict[str, object] | None] = mapped_column(
        MutableDict.as_mutable(JSONB), nullable=True
    )
    idempotency_key: Mapped[str | None] = mapped_column(String(100), nullable=True)
    status: Mapped[str] = mapped_column(String(30), nullable=False)
    attempt_count: Mapped[int] = mapped_column(
        Integer, nullable=False, default=1, server_default=text("1")
    )
    started_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    finished_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    latency_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    target_service: Mapped[str | None] = mapped_column(String(100), nullable=True)
    business_entity_type: Mapped[str | None] = mapped_column(String(100), nullable=True)
    business_entity_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), nullable=True
    )
    error_code: Mapped[str | None] = mapped_column(String(100), nullable=True)

    execution: Mapped[AgentExecution] = relationship(back_populates="tool_calls")
    confirmations: Mapped[list[ConfirmationRequest]] = relationship(
        back_populates="tool_call", overlaps="confirmations,execution"
    )

