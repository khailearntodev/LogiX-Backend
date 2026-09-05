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


class ConfirmationRequest(TenantMutableMixin, Base):
    __tablename__ = "confirmation_requests"
    __table_args__ = (
        CheckConstraint(
            "status IN ('PENDING', 'CONFIRMED', 'REJECTED', 'EXPIRED', 'CONSUMED')",
            name="confirmation_status",
        ),
        ForeignKeyConstraint(
            ["tenant_id", "agent_execution_id"],
            [f"{SCHEMA}.agent_executions.tenant_id", f"{SCHEMA}.agent_executions.id"],
            name="fk_confirmations_tenant_execution",
            ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["tenant_id", "tool_call_id"],
            [f"{SCHEMA}.tool_calls.tenant_id", f"{SCHEMA}.tool_calls.id"],
            name="fk_confirmations_tenant_tool_call",
            ondelete="RESTRICT",
        ),
        Index(
            "ux_pending_tool_confirmation",
            "tenant_id",
            "tool_call_id",
            unique=True,
            postgresql_where=text("status = 'PENDING' AND deleted_at IS NULL"),
        ),
        Index(
            "ix_confirmation_user_pending",
            "tenant_id",
            "user_id",
            "expires_at",
            postgresql_where=text("status = 'PENDING' AND deleted_at IS NULL"),
        ),
        Index(
            "ux_confirmation_context_consumed",
            "tenant_id",
            "user_id",
            "context_hash",
            unique=True,
            postgresql_where=text("status = 'CONSUMED'"),
        ),
        {"schema": SCHEMA},
    )

    user_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), nullable=False)
    agent_execution_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), nullable=False)
    tool_call_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), nullable=False)
    action_type: Mapped[str] = mapped_column(String(100), nullable=False)
    target_type: Mapped[str] = mapped_column(String(100), nullable=False)
    target_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), nullable=False)
    expected_target_version: Mapped[int] = mapped_column(BigInteger, nullable=False)
    preview_payload_sanitized: Mapped[dict[str, object]] = mapped_column(
        MutableDict.as_mutable(JSONB), nullable=False, default=dict, server_default=EMPTY_JSON
    )
    context_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(
        String(30), nullable=False, server_default=text("'PENDING'")
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    confirmed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    consumed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    decision_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    execution: Mapped[AgentExecution] = relationship(
        back_populates="confirmations", overlaps="confirmations,tool_call"
    )
    tool_call: Mapped[ToolCall] = relationship(
        back_populates="confirmations", overlaps="confirmations,execution"
    )

