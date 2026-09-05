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


class Conversation(TenantMutableMixin, Base):
    __tablename__ = "conversations"
    __table_args__ = (
        UniqueConstraint("tenant_id", "id", name="uq_conversations_tenant_id"),
        Index(
            "ix_conversations_user_recent",
            "tenant_id",
            "user_id",
            text("last_message_at DESC"),
            postgresql_where=text("status = 'ACTIVE' AND deleted_at IS NULL"),
        ),
        {"schema": SCHEMA},
    )

    user_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), nullable=False)
    title: Mapped[str | None] = mapped_column(String(200), nullable=True)
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, server_default=text("'ACTIVE'")
    )
    context_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    last_message_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=text("CURRENT_TIMESTAMP")
    )
    expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    messages: Mapped[list[ConversationMessage]] = relationship(
        back_populates="conversation", cascade="save-update, merge"
    )
    executions: Mapped[list[AgentExecution]] = relationship(
        back_populates="conversation", cascade="save-update, merge"
    )

class ConversationMessage(TenantMutableMixin, Base):
    __tablename__ = "conversation_messages"
    __table_args__ = (
        CheckConstraint("sequence > 0", name="message_sequence_positive"),
        CheckConstraint(
            "role IN ('SYSTEM', 'USER', 'ASSISTANT', 'TOOL')",
            name="message_role",
        ),
        ForeignKeyConstraint(
            ["tenant_id", "conversation_id"],
            [f"{SCHEMA}.conversations.tenant_id", f"{SCHEMA}.conversations.id"],
            name="fk_messages_tenant_conversation",
            ondelete="RESTRICT",
        ),
        UniqueConstraint(
            "tenant_id",
            "conversation_id",
            "sequence",
            name="ux_message_sequence",
        ),
        Index(
            "ix_message_timeline",
            "tenant_id",
            "conversation_id",
            "created_at",
            "id",
        ),
        {"schema": SCHEMA},
    )

    conversation_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), nullable=False)
    role: Mapped[str] = mapped_column(String(20), nullable=False)
    content: Mapped[str | None] = mapped_column(Text, nullable=True)
    content_redacted: Mapped[str] = mapped_column(Text, nullable=False)
    model_message_id: Mapped[str | None] = mapped_column(String(200), nullable=True)
    sequence: Mapped[int] = mapped_column(Integer, nullable=False)

    conversation: Mapped[Conversation] = relationship(back_populates="messages")

