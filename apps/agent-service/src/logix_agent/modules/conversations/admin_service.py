"""Tenant-scoped conversation management service (PostgreSQL and InMemory)."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from logix_agent.modules.auth import Actor
from logix_agent.modules.conversations.models import Conversation, ConversationMessage
from logix_agent.modules.conversations.service import (
    InMemoryThreadStore,
    _redact_text,
    validate_thread_id,
)
from logix_agent.modules.executions.ids import to_uuid
from logix_agent.modules.executions.models import AgentExecution, AgentModelCall

CONVERSATION_READ = "agent:conversation:read"
CONVERSATION_MANAGE = "agent:conversation:manage"
ALLOWED_CONVERSATION_STATUSES = frozenset({"ACTIVE", "ARCHIVED"})
MAX_TITLE_LENGTH = 120


class ConversationForbiddenError(Exception):
    pass


class ConversationNotFoundError(Exception):
    pass


class ConversationValidationError(ValueError):
    pass


def can_read_org_conversations(actor: Actor) -> bool:
    return (
        actor.is_super_admin
        or actor.role == "OWNER"
        or "*" in actor.permissions
        or CONVERSATION_READ in actor.permissions
        or CONVERSATION_MANAGE in actor.permissions
    )


def can_manage_org_conversations(actor: Actor) -> bool:
    return (
        actor.is_super_admin
        or actor.role == "OWNER"
        or "*" in actor.permissions
        or CONVERSATION_MANAGE in actor.permissions
    )


@dataclass(frozen=True, slots=True)
class ConversationListItemRecord:
    conversation_id: UUID
    thread_id: str
    user_id: UUID
    title: str | None
    status: str
    message_count: int
    execution_count: int
    last_model: str | None
    total_input_tokens: int
    total_output_tokens: int
    created_at: datetime
    last_message_at: datetime


@dataclass(frozen=True, slots=True)
class ConversationPageRecord:
    items: list[ConversationListItemRecord]
    total: int
    page: int
    page_size: int


@dataclass(frozen=True, slots=True)
class RedactedMessageRecord:
    id: UUID
    role: str
    content: str
    sequence: int
    created_at: datetime


@dataclass(frozen=True, slots=True)
class ExecutionSummaryRecord:
    id: UUID
    status: str
    provider: str | None
    model: str | None
    latency_ms: int | None
    input_tokens: int
    output_tokens: int
    error_code: str | None
    created_at: datetime
    finished_at: datetime | None


@dataclass(frozen=True, slots=True)
class ConversationDetailRecord:
    conversation_id: UUID
    thread_id: str
    user_id: UUID
    is_owner: bool
    title: str | None
    status: str
    message_count: int
    execution_count: int
    last_model: str | None
    total_input_tokens: int
    total_output_tokens: int
    created_at: datetime
    last_message_at: datetime
    messages: list[RedactedMessageRecord]
    executions: list[ExecutionSummaryRecord]


def _normalize_title(title: str | None) -> str | None:
    if title is None:
        return None
    cleaned = " ".join(title.split())
    if not cleaned:
        raise ConversationValidationError("Tiêu đề hội thoại không được để trống.")
    if len(cleaned) > MAX_TITLE_LENGTH:
        raise ConversationValidationError(
            f"Tiêu đề hội thoại không được vượt quá {MAX_TITLE_LENGTH} ký tự."
        )
    return cleaned


def _normalize_status(status_value: str | None) -> str | None:
    if status_value is None:
        return None
    upper = status_value.strip().upper()
    if upper not in ALLOWED_CONVERSATION_STATUSES:
        raise ConversationValidationError("Trạng thái hội thoại không hợp lệ.")
    return upper


class SqlAlchemyConversationAdminService:
    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._session_factory = session_factory

    async def list_conversations(
        self,
        actor: Actor,
        *,
        scope: str = "org",
        page: int = 1,
        page_size: int = 20,
        user_id: str | None = None,
        status: str | None = None,
        q: str | None = None,
        date_from: datetime | None = None,
        date_to: datetime | None = None,
    ) -> ConversationPageRecord:
        if scope not in ("org", "mine"):
            raise ConversationValidationError("Phạm vi truy vấn không hợp lệ.")
        if scope == "org" and not can_read_org_conversations(actor):
            raise ConversationForbiddenError(
                "Bạn không có quyền xem danh sách hội thoại AI của tổ chức."
            )

        tenant_uuid = to_uuid(actor.tenant_id)
        filters = [
            Conversation.tenant_id == tenant_uuid,
            Conversation.deleted_at.is_(None),
            Conversation.status.in_(tuple(ALLOWED_CONVERSATION_STATUSES)),
        ]
        if scope == "mine":
            filters.append(Conversation.user_id == to_uuid(actor.user_id))
        elif user_id:
            try:
                filters.append(Conversation.user_id == UUID(user_id))
            except ValueError as exc:
                raise ConversationValidationError("Mã người dùng không hợp lệ.") from exc

        normalized_status = _normalize_status(status)
        if normalized_status is not None:
            filters.append(Conversation.status == normalized_status)

        if q and q.strip():
            pattern = f"%{q.strip()}%"
            filters.append(
                or_(
                    Conversation.title.ilike(pattern),
                    Conversation.thread_id.ilike(pattern),
                )
            )
        if date_from is not None:
            filters.append(Conversation.last_message_at >= date_from)
        if date_to is not None:
            filters.append(Conversation.last_message_at <= date_to)

        offset = (page - 1) * page_size
        async with self._session_factory() as session:
            total = int(
                (await session.scalar(select(func.count(Conversation.id)).where(*filters))) or 0
            )
            rows = (
                await session.scalars(
                    select(Conversation)
                    .where(*filters)
                    .order_by(Conversation.last_message_at.desc(), Conversation.created_at.desc())
                    .offset(offset)
                    .limit(page_size)
                )
            ).all()

            conv_ids = [row.id for row in rows]
            msg_counts: dict[UUID, int] = {}
            exec_counts: dict[UUID, int] = {}
            last_models: dict[UUID, str | None] = {}
            token_totals: dict[UUID, tuple[int, int]] = {}

            if conv_ids:
                msg_rows = (
                    await session.execute(
                        select(
                            ConversationMessage.conversation_id,
                            func.count(ConversationMessage.id),
                        )
                        .where(
                            ConversationMessage.tenant_id == tenant_uuid,
                            ConversationMessage.conversation_id.in_(conv_ids),
                            ConversationMessage.deleted_at.is_(None),
                        )
                        .group_by(ConversationMessage.conversation_id)
                    )
                ).all()
                msg_counts = {cid: int(cnt) for cid, cnt in msg_rows}

                exec_rows = (
                    await session.execute(
                        select(
                            AgentExecution.conversation_id,
                            AgentExecution.model,
                            AgentExecution.created_at,
                        )
                        .where(
                            AgentExecution.tenant_id == tenant_uuid,
                            AgentExecution.conversation_id.in_(conv_ids),
                            AgentExecution.deleted_at.is_(None),
                        )
                        .order_by(AgentExecution.created_at.desc())
                    )
                ).all()
                for cid, model_name, _ in exec_rows:
                    if cid is None:
                        continue
                    exec_counts[cid] = exec_counts.get(cid, 0) + 1
                    if cid not in last_models and model_name:
                        last_models[cid] = model_name

                token_rows = (
                    await session.execute(
                        select(
                            AgentExecution.conversation_id,
                            func.coalesce(func.sum(AgentModelCall.input_tokens), 0),
                            func.coalesce(func.sum(AgentModelCall.output_tokens), 0),
                        )
                        .join(
                            AgentExecution,
                            (AgentModelCall.tenant_id == AgentExecution.tenant_id)
                            & (AgentModelCall.agent_execution_id == AgentExecution.id),
                        )
                        .where(
                            AgentExecution.tenant_id == tenant_uuid,
                            AgentExecution.conversation_id.in_(conv_ids),
                            AgentExecution.deleted_at.is_(None),
                            AgentModelCall.deleted_at.is_(None),
                        )
                        .group_by(AgentExecution.conversation_id)
                    )
                ).all()
                token_totals = {
                    cid: (int(inp), int(out))
                    for cid, inp, out in token_rows
                    if cid is not None
                }

            items = [
                ConversationListItemRecord(
                    conversation_id=row.id,
                    thread_id=row.thread_id or str(row.id),
                    user_id=row.user_id,
                    title=row.title,
                    status=row.status,
                    message_count=msg_counts.get(row.id, 0),
                    execution_count=exec_counts.get(row.id, 0),
                    last_model=last_models.get(row.id),
                    total_input_tokens=token_totals.get(row.id, (0, 0))[0],
                    total_output_tokens=token_totals.get(row.id, (0, 0))[1],
                    created_at=row.created_at,
                    last_message_at=row.last_message_at,
                )
                for row in rows
            ]
            return ConversationPageRecord(
                items=items,
                total=total,
                page=page,
                page_size=page_size,
            )

    async def _find_conversation(
        self, session: AsyncSession, tenant_uuid: UUID, thread_id: str
    ) -> Conversation | None:
        validate_thread_id(thread_id)
        conv_id = to_uuid(thread_id)
        return await session.scalar(
            select(Conversation).where(
                Conversation.tenant_id == tenant_uuid,
                Conversation.deleted_at.is_(None),
                Conversation.status.in_(tuple(ALLOWED_CONVERSATION_STATUSES)),
                or_(Conversation.id == conv_id, Conversation.thread_id == thread_id),
            )
        )

    async def get_conversation_detail(
        self, actor: Actor, thread_id: str
    ) -> ConversationDetailRecord:
        tenant_uuid = to_uuid(actor.tenant_id)
        actor_user_uuid = to_uuid(actor.user_id)
        async with self._session_factory() as session:
            conv = await self._find_conversation(session, tenant_uuid, thread_id)
            if conv is None:
                raise ConversationNotFoundError(thread_id)
            is_owner = conv.user_id == actor_user_uuid
            if not is_owner and not can_read_org_conversations(actor):
                raise ConversationForbiddenError(
                    "Bạn không có quyền xem chi tiết hội thoại này."
                )

            msg_rows = (
                await session.scalars(
                    select(ConversationMessage)
                    .where(
                        ConversationMessage.tenant_id == tenant_uuid,
                        ConversationMessage.conversation_id == conv.id,
                        ConversationMessage.deleted_at.is_(None),
                    )
                    .order_by(ConversationMessage.sequence.asc())
                )
            ).all()

            exec_rows = (
                await session.scalars(
                    select(AgentExecution)
                    .where(
                        AgentExecution.tenant_id == tenant_uuid,
                        AgentExecution.conversation_id == conv.id,
                        AgentExecution.deleted_at.is_(None),
                    )
                    .order_by(AgentExecution.created_at.desc())
                    .limit(50)
                )
            ).all()

            exec_ids = [e.id for e in exec_rows]
            tokens_by_exec: dict[UUID, tuple[int, int]] = {}
            if exec_ids:
                call_rows = (
                    await session.execute(
                        select(
                            AgentModelCall.agent_execution_id,
                            func.coalesce(func.sum(AgentModelCall.input_tokens), 0),
                            func.coalesce(func.sum(AgentModelCall.output_tokens), 0),
                        )
                        .where(
                            AgentModelCall.tenant_id == tenant_uuid,
                            AgentModelCall.agent_execution_id.in_(exec_ids),
                            AgentModelCall.deleted_at.is_(None),
                        )
                        .group_by(AgentModelCall.agent_execution_id)
                    )
                ).all()
                tokens_by_exec = {eid: (int(inp), int(out)) for eid, inp, out in call_rows}

            total_in = sum(t[0] for t in tokens_by_exec.values())
            total_out = sum(t[1] for t in tokens_by_exec.values())
            last_model = next((e.model for e in exec_rows if e.model), None)

            return ConversationDetailRecord(
                conversation_id=conv.id,
                thread_id=conv.thread_id or str(conv.id),
                user_id=conv.user_id,
                is_owner=is_owner,
                title=conv.title,
                status=conv.status,
                message_count=len(msg_rows),
                execution_count=len(exec_rows),
                last_model=last_model,
                total_input_tokens=total_in,
                total_output_tokens=total_out,
                created_at=conv.created_at,
                last_message_at=conv.last_message_at,
                messages=[
                    RedactedMessageRecord(
                        id=m.id,
                        role=m.role,
                        content=m.content_redacted,
                        sequence=m.sequence,
                        created_at=m.created_at,
                    )
                    for m in msg_rows
                ],
                executions=[
                    ExecutionSummaryRecord(
                        id=e.id,
                        status=e.status,
                        provider=e.provider,
                        model=e.model,
                        latency_ms=e.latency_ms,
                        input_tokens=tokens_by_exec.get(e.id, (0, 0))[0],
                        output_tokens=tokens_by_exec.get(e.id, (0, 0))[1],
                        error_code=e.error_code,
                        created_at=e.created_at,
                        finished_at=e.finished_at,
                    )
                    for e in exec_rows
                ],
            )

    async def update_conversation(
        self,
        actor: Actor,
        thread_id: str,
        *,
        title: str | None = None,
        status: str | None = None,
    ) -> ConversationListItemRecord:
        normalized_title = _normalize_title(title)
        normalized_status = _normalize_status(status)
        if normalized_title is None and normalized_status is None:
            raise ConversationValidationError("Cần cung cấp tiêu đề hoặc trạng thái để cập nhật.")

        tenant_uuid = to_uuid(actor.tenant_id)
        actor_user_uuid = to_uuid(actor.user_id)
        async with self._session_factory() as session:
            conv = await self._find_conversation(session, tenant_uuid, thread_id)
            if conv is None:
                raise ConversationNotFoundError(thread_id)
            is_owner = conv.user_id == actor_user_uuid
            if not is_owner and not can_manage_org_conversations(actor):
                raise ConversationForbiddenError(
                    "Bạn không có quyền cập nhật hội thoại này."
                )

            if normalized_title is not None:
                conv.title = normalized_title
            if normalized_status is not None:
                conv.status = normalized_status
            conv.updated_at = datetime.now(UTC)
            conv.version = (conv.version or 1) + 1
            await session.commit()
            await session.refresh(conv)

            msg_count = int(
                (
                    await session.scalar(
                        select(func.count(ConversationMessage.id)).where(
                            ConversationMessage.tenant_id == tenant_uuid,
                            ConversationMessage.conversation_id == conv.id,
                            ConversationMessage.deleted_at.is_(None),
                        )
                    )
                )
                or 0
            )
            return ConversationListItemRecord(
                conversation_id=conv.id,
                thread_id=conv.thread_id or str(conv.id),
                user_id=conv.user_id,
                title=conv.title,
                status=conv.status,
                message_count=msg_count,
                execution_count=0,
                last_model=None,
                total_input_tokens=0,
                total_output_tokens=0,
                created_at=conv.created_at,
                last_message_at=conv.last_message_at,
            )

    async def delete_conversation(self, actor: Actor, thread_id: str) -> None:
        tenant_uuid = to_uuid(actor.tenant_id)
        actor_user_uuid = to_uuid(actor.user_id)
        async with self._session_factory() as session:
            conv = await self._find_conversation(session, tenant_uuid, thread_id)
            if conv is None:
                raise ConversationNotFoundError(thread_id)
            is_owner = conv.user_id == actor_user_uuid
            if not is_owner and not can_manage_org_conversations(actor):
                raise ConversationForbiddenError("Bạn không có quyền xóa hội thoại này.")

            now = datetime.now(UTC)
            conv.deleted_at = now
            conv.updated_at = now
            conv.status = "DELETED"
            conv.version = (conv.version or 1) + 1
            await session.commit()


class InMemoryConversationAdminService:
    """In-memory implementation mirroring SqlAlchemyConversationAdminService for tests/dev."""

    def __init__(self, thread_store: InMemoryThreadStore) -> None:
        self._store = thread_store

    async def list_conversations(
        self,
        actor: Actor,
        *,
        scope: str = "org",
        page: int = 1,
        page_size: int = 20,
        user_id: str | None = None,
        status: str | None = None,
        q: str | None = None,
        date_from: datetime | None = None,
        date_to: datetime | None = None,
    ) -> ConversationPageRecord:
        if scope not in ("org", "mine"):
            raise ConversationValidationError("Phạm vi truy vấn không hợp lệ.")
        if scope == "org" and not can_read_org_conversations(actor):
            raise ConversationForbiddenError(
                "Bạn không có quyền xem danh sách hội thoại AI của tổ chức."
            )
        tenant_uuid = to_uuid(actor.tenant_id)
        target_user_uuid: UUID | None = None
        if scope == "mine":
            target_user_uuid = to_uuid(actor.user_id)
        elif user_id:
            try:
                target_user_uuid = UUID(user_id)
            except ValueError as exc:
                raise ConversationValidationError("Mã người dùng không hợp lệ.") from exc
        normalized_status = _normalize_status(status)
        search_lower = q.strip().lower() if q and q.strip() else None

        with self._store._lock:  # noqa: SLF001
            matched = []
            for conv in self._store._conversations.values():  # noqa: SLF001
                if (
                    conv.tenant_id != tenant_uuid
                    or conv.deleted_at is not None
                    or conv.status not in ALLOWED_CONVERSATION_STATUSES
                ):
                    continue
                if target_user_uuid is not None and conv.user_id != target_user_uuid:
                    continue
                if normalized_status is not None and conv.status != normalized_status:
                    continue
                if search_lower is not None:
                    title_match = (conv.title or "").lower()
                    if search_lower not in title_match and search_lower not in conv.thread_id.lower():
                        continue
                if date_from is not None and conv.last_message_at < date_from:
                    continue
                if date_to is not None and conv.last_message_at > date_to:
                    continue
                matched.append(conv)

            matched.sort(key=lambda c: (c.last_message_at, c.created_at), reverse=True)
            total = len(matched)
            start = (page - 1) * page_size
            slice_rows = matched[start : start + page_size]
            items = [
                ConversationListItemRecord(
                    conversation_id=c.id,
                    thread_id=c.thread_id,
                    user_id=c.user_id,
                    title=c.title,
                    status=c.status,
                    message_count=len(c.messages),
                    execution_count=0,
                    last_model=None,
                    total_input_tokens=0,
                    total_output_tokens=0,
                    created_at=c.created_at,
                    last_message_at=c.last_message_at,
                )
                for c in slice_rows
            ]
            return ConversationPageRecord(items=items, total=total, page=page, page_size=page_size)

    async def get_conversation_detail(
        self, actor: Actor, thread_id: str
    ) -> ConversationDetailRecord:
        validate_thread_id(thread_id)
        tenant_uuid = to_uuid(actor.tenant_id)
        actor_user_uuid = to_uuid(actor.user_id)
        conv_id = to_uuid(thread_id)
        with self._store._lock:  # noqa: SLF001
            conv = self._store._conversations.get(conv_id)  # noqa: SLF001
            if (
                conv is None
                or conv.tenant_id != tenant_uuid
                or conv.deleted_at is not None
                or conv.status not in ALLOWED_CONVERSATION_STATUSES
            ):
                raise ConversationNotFoundError(thread_id)
            is_owner = conv.user_id == actor_user_uuid
            if not is_owner and not can_read_org_conversations(actor):
                raise ConversationForbiddenError("Bạn không có quyền xem chi tiết hội thoại này.")
            return ConversationDetailRecord(
                conversation_id=conv.id,
                thread_id=conv.thread_id,
                user_id=conv.user_id,
                is_owner=is_owner,
                title=conv.title,
                status=conv.status,
                message_count=len(conv.messages),
                execution_count=0,
                last_model=None,
                total_input_tokens=0,
                total_output_tokens=0,
                created_at=conv.created_at,
                last_message_at=conv.last_message_at,
                messages=[
                    RedactedMessageRecord(
                        id=m.id,
                        role=m.role,
                        content=_redact_text(m.content),
                        sequence=m.sequence,
                        created_at=m.created_at,
                    )
                    for m in conv.messages
                ],
                executions=[],
            )

    async def update_conversation(
        self,
        actor: Actor,
        thread_id: str,
        *,
        title: str | None = None,
        status: str | None = None,
    ) -> ConversationListItemRecord:
        validate_thread_id(thread_id)
        normalized_title = _normalize_title(title)
        normalized_status = _normalize_status(status)
        if normalized_title is None and normalized_status is None:
            raise ConversationValidationError("Cần cung cấp tiêu đề hoặc trạng thái để cập nhật.")
        tenant_uuid = to_uuid(actor.tenant_id)
        actor_user_uuid = to_uuid(actor.user_id)
        conv_id = to_uuid(thread_id)
        with self._store._lock:  # noqa: SLF001
            conv = self._store._conversations.get(conv_id)  # noqa: SLF001
            if (
                conv is None
                or conv.tenant_id != tenant_uuid
                or conv.deleted_at is not None
                or conv.status not in ALLOWED_CONVERSATION_STATUSES
            ):
                raise ConversationNotFoundError(thread_id)
            is_owner = conv.user_id == actor_user_uuid
            if not is_owner and not can_manage_org_conversations(actor):
                raise ConversationForbiddenError("Bạn không có quyền cập nhật hội thoại này.")
            if normalized_title is not None:
                conv.title = normalized_title
            if normalized_status is not None:
                conv.status = normalized_status
            return ConversationListItemRecord(
                conversation_id=conv.id,
                thread_id=conv.thread_id,
                user_id=conv.user_id,
                title=conv.title,
                status=conv.status,
                message_count=len(conv.messages),
                execution_count=0,
                last_model=None,
                total_input_tokens=0,
                total_output_tokens=0,
                created_at=conv.created_at,
                last_message_at=conv.last_message_at,
            )

    async def delete_conversation(self, actor: Actor, thread_id: str) -> None:
        validate_thread_id(thread_id)
        tenant_uuid = to_uuid(actor.tenant_id)
        actor_user_uuid = to_uuid(actor.user_id)
        conv_id = to_uuid(thread_id)
        with self._store._lock:  # noqa: SLF001
            conv = self._store._conversations.get(conv_id)  # noqa: SLF001
            if (
                conv is None
                or conv.tenant_id != tenant_uuid
                or conv.deleted_at is not None
                or conv.status not in ALLOWED_CONVERSATION_STATUSES
            ):
                raise ConversationNotFoundError(thread_id)
            is_owner = conv.user_id == actor_user_uuid
            if not is_owner and not can_manage_org_conversations(actor):
                raise ConversationForbiddenError("Bạn không có quyền xóa hội thoại này.")
            conv.deleted_at = datetime.now(UTC)
            conv.status = "DELETED"
