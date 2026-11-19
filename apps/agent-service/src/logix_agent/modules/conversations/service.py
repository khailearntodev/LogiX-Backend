"""Conversation and thread ownership persistence (InMemory and PostgreSQL)."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from threading import Lock
from typing import Protocol
from uuid import UUID, uuid4

from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from logix_agent.modules.auth import Actor
from logix_agent.modules.conversations.models import Conversation, ConversationMessage
from logix_agent.modules.executions.ids import to_uuid

_THREAD_ID = re.compile(r"^[A-Za-z0-9_-]{8,100}$")
_BEARER_RE = re.compile(r"(Bearer\s+)[A-Za-z0-9\-._~+/]+=*", re.IGNORECASE)
_MAX_TITLE_LEN = 120


class ThreadNotFoundError(Exception):
    pass


class InvalidThreadIdError(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class ThreadSummary:
    thread_id: str
    title: str | None
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class StoredMessage:
    id: UUID
    role: str
    content: str
    sequence: int
    model_message_id: str | None
    created_at: datetime


class ThreadStore(Protocol):
    async def claim(self, thread_id: str, actor: Actor) -> UUID:
        """Ensure thread ownership belongs to actor and return conversation UUID."""
        ...

    async def record_message(
        self,
        *,
        tenant_id: str | UUID,
        thread_id: str,
        role: str,
        content: str,
        model_message_id: str | None = None,
    ) -> None:
        """Append a conversation message and refresh thread title / timestamp."""
        ...

    async def list_threads(self, actor: Actor, *, limit: int = 50) -> list[ThreadSummary]:
        """Return active threads owned by actor ordered newest first."""
        ...

    async def list_messages(self, thread_id: str, actor: Actor) -> list[StoredMessage]:
        """Return stored plain-text messages for an owned thread."""
        ...

    async def delete_thread(self, thread_id: str, actor: Actor) -> None:
        """Soft-delete an active thread owned by actor."""
        ...


def validate_thread_id(thread_id: str) -> str:
    if not _THREAD_ID.fullmatch(thread_id):
        raise InvalidThreadIdError(thread_id)
    return thread_id


def _now() -> datetime:
    return datetime.now(UTC)


def _derive_title(text: str) -> str | None:
    collapsed = " ".join(text.split())
    if not collapsed:
        return None
    if len(collapsed) <= _MAX_TITLE_LEN:
        return collapsed
    return collapsed[: _MAX_TITLE_LEN - 3].rstrip() + "..."


def _redact_text(text: str) -> str:
    return _BEARER_RE.sub(r"\1[REDACTED]", text)


@dataclass
class _MemoryConversation:
    id: UUID
    tenant_id: UUID
    user_id: UUID
    thread_id: str
    title: str | None = None
    status: str = "ACTIVE"
    created_at: datetime = field(default_factory=_now)
    last_message_at: datetime = field(default_factory=_now)
    deleted_at: datetime | None = None
    messages: list[StoredMessage] = field(default_factory=list)


class InMemoryThreadStore:
    def __init__(self) -> None:
        self._conversations: dict[UUID, _MemoryConversation] = {}
        self._lock = Lock()

    async def claim(self, thread_id: str, actor: Actor) -> UUID:
        validate_thread_id(thread_id)
        conv_id = to_uuid(thread_id)
        tenant_uuid = to_uuid(actor.tenant_id)
        user_uuid = to_uuid(actor.user_id)
        with self._lock:
            existing = self._conversations.get(conv_id)
            if existing is None:
                self._conversations[conv_id] = _MemoryConversation(
                    id=conv_id,
                    tenant_id=tenant_uuid,
                    user_id=user_uuid,
                    thread_id=thread_id,
                )
                return conv_id
            if (
                existing.deleted_at is not None
                or existing.status != "ACTIVE"
                or existing.tenant_id != tenant_uuid
                or existing.user_id != user_uuid
            ):
                raise ThreadNotFoundError(thread_id)
            return existing.id

    async def record_message(
        self,
        *,
        tenant_id: str | UUID,
        thread_id: str,
        role: str,
        content: str,
        model_message_id: str | None = None,
    ) -> None:
        if not content or not content.strip():
            return
        conv_id = to_uuid(thread_id)
        tenant_uuid = to_uuid(tenant_id)
        normalized_role = role.upper()
        with self._lock:
            conv = self._conversations.get(conv_id)
            if (
                conv is None
                or conv.tenant_id != tenant_uuid
                or conv.deleted_at is not None
                or conv.status != "ACTIVE"
            ):
                return
            if model_message_id and any(
                m.model_message_id == model_message_id for m in conv.messages
            ):
                return
            now = _now()
            seq = len(conv.messages) + 1
            conv.messages.append(
                StoredMessage(
                    id=uuid4(),
                    role=normalized_role,
                    content=content,
                    sequence=seq,
                    model_message_id=model_message_id,
                    created_at=now,
                )
            )
            conv.last_message_at = now
            if normalized_role == "USER" and not conv.title:
                conv.title = _derive_title(content)

    async def list_threads(self, actor: Actor, *, limit: int = 50) -> list[ThreadSummary]:
        tenant_uuid = to_uuid(actor.tenant_id)
        user_uuid = to_uuid(actor.user_id)
        with self._lock:
            owned = [
                c
                for c in self._conversations.values()
                if c.tenant_id == tenant_uuid
                and c.user_id == user_uuid
                and c.deleted_at is None
                and c.status == "ACTIVE"
            ]
            owned.sort(key=lambda c: (c.last_message_at, c.created_at), reverse=True)
            return [
                ThreadSummary(
                    thread_id=c.thread_id,
                    title=c.title,
                    created_at=c.created_at,
                    updated_at=c.last_message_at,
                )
                for c in owned[:limit]
            ]

    async def list_messages(self, thread_id: str, actor: Actor) -> list[StoredMessage]:
        validate_thread_id(thread_id)
        conv_id = to_uuid(thread_id)
        tenant_uuid = to_uuid(actor.tenant_id)
        user_uuid = to_uuid(actor.user_id)
        with self._lock:
            conv = self._conversations.get(conv_id)
            if (
                conv is None
                or conv.deleted_at is not None
                or conv.status != "ACTIVE"
                or conv.tenant_id != tenant_uuid
                or conv.user_id != user_uuid
            ):
                raise ThreadNotFoundError(thread_id)
            return list(conv.messages)

    async def delete_thread(self, thread_id: str, actor: Actor) -> None:
        validate_thread_id(thread_id)
        conv_id = to_uuid(thread_id)
        tenant_uuid = to_uuid(actor.tenant_id)
        user_uuid = to_uuid(actor.user_id)
        with self._lock:
            conv = self._conversations.get(conv_id)
            if (
                conv is None
                or conv.deleted_at is not None
                or conv.status != "ACTIVE"
                or conv.tenant_id != tenant_uuid
                or conv.user_id != user_uuid
            ):
                raise ThreadNotFoundError(thread_id)
            conv.deleted_at = _now()
            conv.status = "DELETED"


class SqlAlchemyThreadStore:
    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._session_factory = session_factory

    async def claim(self, thread_id: str, actor: Actor) -> UUID:
        validate_thread_id(thread_id)
        conv_id = to_uuid(thread_id)
        tenant_uuid = to_uuid(actor.tenant_id)
        user_uuid = to_uuid(actor.user_id)
        now = _now()
        stmt = (
            pg_insert(Conversation)
            .values(
                id=conv_id,
                tenant_id=tenant_uuid,
                user_id=user_uuid,
                thread_id=thread_id,
                status="ACTIVE",
                last_message_at=now,
            )
            .on_conflict_do_nothing()
        )
        async with self._session_factory() as session:
            await session.execute(stmt)
            row = await session.scalar(select(Conversation).where(Conversation.id == conv_id))
            if (
                row is None
                or row.deleted_at is not None
                or row.status != "ACTIVE"
                or row.tenant_id != tenant_uuid
                or row.user_id != user_uuid
            ):
                await session.commit()
                raise ThreadNotFoundError(thread_id)
            if not row.thread_id:
                row.thread_id = thread_id
            await session.commit()
            return row.id

    async def record_message(
        self,
        *,
        tenant_id: str | UUID,
        thread_id: str,
        role: str,
        content: str,
        model_message_id: str | None = None,
    ) -> None:
        if not content or not content.strip():
            return
        conv_id = to_uuid(thread_id)
        tenant_uuid = to_uuid(tenant_id)
        normalized_role = role.upper()
        redacted = _redact_text(content)
        now = _now()
        async with self._session_factory() as session:
            conv = await session.scalar(
                select(Conversation).where(
                    Conversation.id == conv_id,
                    Conversation.tenant_id == tenant_uuid,
                    Conversation.deleted_at.is_(None),
                    Conversation.status == "ACTIVE",
                )
            )
            if conv is None:
                return
            if model_message_id:
                existing_id = await session.scalar(
                    select(ConversationMessage.id).where(
                        ConversationMessage.tenant_id == tenant_uuid,
                        ConversationMessage.conversation_id == conv_id,
                        ConversationMessage.model_message_id == model_message_id,
                        ConversationMessage.deleted_at.is_(None),
                    )
                )
                if existing_id is not None:
                    return
            next_sequence = await session.scalar(
                select(func.coalesce(func.max(ConversationMessage.sequence), 0) + 1).where(
                    ConversationMessage.tenant_id == tenant_uuid,
                    ConversationMessage.conversation_id == conv_id,
                )
            )
            session.add(
                ConversationMessage(
                    id=uuid4(),
                    tenant_id=tenant_uuid,
                    conversation_id=conv_id,
                    role=normalized_role,
                    content=content,
                    content_redacted=redacted,
                    model_message_id=model_message_id,
                    sequence=next_sequence or 1,
                )
            )
            conv.last_message_at = now
            conv.updated_at = now
            if normalized_role == "USER" and not conv.title:
                conv.title = _derive_title(content)
            await session.commit()

    async def list_threads(self, actor: Actor, *, limit: int = 50) -> list[ThreadSummary]:
        tenant_uuid = to_uuid(actor.tenant_id)
        user_uuid = to_uuid(actor.user_id)
        stmt = (
            select(Conversation)
            .where(
                Conversation.tenant_id == tenant_uuid,
                Conversation.user_id == user_uuid,
                Conversation.deleted_at.is_(None),
                Conversation.status == "ACTIVE",
            )
            .order_by(Conversation.last_message_at.desc(), Conversation.created_at.desc())
            .limit(limit)
        )
        async with self._session_factory() as session:
            rows = (await session.scalars(stmt)).all()
            return [
                ThreadSummary(
                    thread_id=row.thread_id or str(row.id),
                    title=row.title,
                    created_at=row.created_at,
                    updated_at=row.last_message_at,
                )
                for row in rows
            ]

    async def list_messages(self, thread_id: str, actor: Actor) -> list[StoredMessage]:
        validate_thread_id(thread_id)
        conv_id = to_uuid(thread_id)
        tenant_uuid = to_uuid(actor.tenant_id)
        user_uuid = to_uuid(actor.user_id)
        async with self._session_factory() as session:
            conv = await session.scalar(
                select(Conversation).where(
                    Conversation.id == conv_id,
                    Conversation.tenant_id == tenant_uuid,
                    Conversation.user_id == user_uuid,
                    Conversation.deleted_at.is_(None),
                    Conversation.status == "ACTIVE",
                )
            )
            if conv is None:
                raise ThreadNotFoundError(thread_id)
            rows = (
                await session.scalars(
                    select(ConversationMessage)
                    .where(
                        ConversationMessage.tenant_id == tenant_uuid,
                        ConversationMessage.conversation_id == conv_id,
                        ConversationMessage.deleted_at.is_(None),
                    )
                    .order_by(ConversationMessage.sequence.asc())
                )
            ).all()
            return [
                StoredMessage(
                    id=row.id,
                    role=row.role,
                    content=row.content or row.content_redacted,
                    sequence=row.sequence,
                    model_message_id=row.model_message_id,
                    created_at=row.created_at,
                )
                for row in rows
            ]

    async def delete_thread(self, thread_id: str, actor: Actor) -> None:
        validate_thread_id(thread_id)
        conv_id = to_uuid(thread_id)
        tenant_uuid = to_uuid(actor.tenant_id)
        user_uuid = to_uuid(actor.user_id)
        now = _now()
        stmt = (
            update(Conversation)
            .where(
                Conversation.id == conv_id,
                Conversation.tenant_id == tenant_uuid,
                Conversation.user_id == user_uuid,
                Conversation.deleted_at.is_(None),
                Conversation.status == "ACTIVE",
            )
            .values(
                deleted_at=now,
                updated_at=now,
                status="DELETED",
                version=Conversation.version + 1,
            )
            .returning(Conversation.id)
        )
        async with self._session_factory() as session:
            deleted_id = await session.scalar(stmt)
            await session.commit()
            if deleted_id is None:
                raise ThreadNotFoundError(thread_id)
