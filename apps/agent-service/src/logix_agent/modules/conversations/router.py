"""Tenant-scoped Conversation Management Center API router."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from logix_agent.modules.auth import Actor, get_current_actor
from logix_agent.modules.conversations.admin_service import (
    ConversationDetailRecord,
    ConversationForbiddenError,
    ConversationListItemRecord,
    ConversationNotFoundError,
    ConversationValidationError,
    InMemoryConversationAdminService,
    SqlAlchemyConversationAdminService,
)
from logix_agent.modules.conversations.service import (
    InMemoryThreadStore,
    InvalidThreadIdError,
)

router = APIRouter(prefix="/api/v1/agent/conversations", tags=["Agent conversations"])


class _CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class ConversationListItemResponse(_CamelModel):
    conversation_id: str
    thread_id: str
    user_id: str
    title: str | None = None
    status: str
    message_count: int
    execution_count: int
    last_model: str | None = None
    total_input_tokens: int
    total_output_tokens: int
    created_at: datetime
    last_message_at: datetime


class ConversationPageResponse(_CamelModel):
    items: list[ConversationListItemResponse]
    total: int
    page: int
    page_size: int


class RedactedMessageResponse(_CamelModel):
    id: str
    role: str
    content: str
    sequence: int
    created_at: datetime


class ExecutionSummaryResponse(_CamelModel):
    id: str
    status: str
    provider: str | None = None
    model: str | None = None
    latency_ms: int | None = None
    input_tokens: int
    output_tokens: int
    error_code: str | None = None
    created_at: datetime
    finished_at: datetime | None = None


class ConversationDetailResponse(ConversationListItemResponse):
    is_owner: bool
    messages: list[RedactedMessageResponse]
    executions: list[ExecutionSummaryResponse]


class UpdateConversationRequest(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )

    title: str | None = Field(default=None, max_length=120)
    status: Literal["ACTIVE", "ARCHIVED"] | None = None


def _to_list_item(record: ConversationListItemRecord) -> ConversationListItemResponse:
    return ConversationListItemResponse(
        conversation_id=str(record.conversation_id),
        thread_id=record.thread_id,
        user_id=str(record.user_id),
        title=record.title,
        status=record.status,
        message_count=record.message_count,
        execution_count=record.execution_count,
        last_model=record.last_model,
        total_input_tokens=record.total_input_tokens,
        total_output_tokens=record.total_output_tokens,
        created_at=record.created_at,
        last_message_at=record.last_message_at,
    )


def _to_detail(record: ConversationDetailRecord) -> ConversationDetailResponse:
    return ConversationDetailResponse(
        conversation_id=str(record.conversation_id),
        thread_id=record.thread_id,
        user_id=str(record.user_id),
        is_owner=record.is_owner,
        title=record.title,
        status=record.status,
        message_count=record.message_count,
        execution_count=record.execution_count,
        last_model=record.last_model,
        total_input_tokens=record.total_input_tokens,
        total_output_tokens=record.total_output_tokens,
        created_at=record.created_at,
        last_message_at=record.last_message_at,
        messages=[
            RedactedMessageResponse(
                id=str(m.id),
                role=m.role,
                content=m.content,
                sequence=m.sequence,
                created_at=m.created_at,
            )
            for m in record.messages
        ],
        executions=[
            ExecutionSummaryResponse(
                id=str(e.id),
                status=e.status,
                provider=e.provider,
                model=e.model,
                latency_ms=e.latency_ms,
                input_tokens=e.input_tokens,
                output_tokens=e.output_tokens,
                error_code=e.error_code,
                created_at=e.created_at,
                finished_at=e.finished_at,
            )
            for e in record.executions
        ],
    )


def get_conversation_admin_service(
    request: Request,
) -> SqlAlchemyConversationAdminService | InMemoryConversationAdminService:
    service = getattr(request.app.state, "conversation_admin_service", None)
    if service is not None:
        return service
    runtime = getattr(request.app.state, "agui_runtime", None)
    if runtime is not None and isinstance(runtime.thread_store, InMemoryThreadStore):
        return InMemoryConversationAdminService(runtime.thread_store)
    raise HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail="Dịch vụ quản lý hội thoại AI hiện chưa sẵn sàng.",
    )


@router.get("", response_model=ConversationPageResponse)
async def list_conversations(
    scope: Literal["org", "mine"] = Query(default="org"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, alias="pageSize", ge=1, le=100),
    user_id: str | None = Query(default=None, alias="userId"),
    conv_status: str | None = Query(default=None, alias="status"),
    q: str | None = Query(default=None, max_length=200),
    date_from: datetime | None = Query(default=None, alias="dateFrom"),
    date_to: datetime | None = Query(default=None, alias="dateTo"),
    actor: Actor = Depends(get_current_actor),
    service: SqlAlchemyConversationAdminService | InMemoryConversationAdminService = Depends(
        get_conversation_admin_service
    ),
) -> ConversationPageResponse:
    try:
        result = await service.list_conversations(
            actor,
            scope=scope,
            page=page,
            page_size=page_size,
            user_id=user_id,
            status=conv_status,
            q=q,
            date_from=date_from,
            date_to=date_to,
        )
    except ConversationForbiddenError as exc:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc)) from exc
    except ConversationValidationError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    return ConversationPageResponse(
        items=[_to_list_item(item) for item in result.items],
        total=result.total,
        page=result.page,
        page_size=result.page_size,
    )


@router.get("/{thread_id}", response_model=ConversationDetailResponse)
async def get_conversation_detail(
    thread_id: str,
    actor: Actor = Depends(get_current_actor),
    service: SqlAlchemyConversationAdminService | InMemoryConversationAdminService = Depends(
        get_conversation_admin_service
    ),
) -> ConversationDetailResponse:
    try:
        record = await service.get_conversation_detail(actor, thread_id)
    except InvalidThreadIdError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Mã hội thoại không hợp lệ."
        ) from exc
    except ConversationForbiddenError as exc:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc)) from exc
    except ConversationNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Không tìm thấy hội thoại."
        ) from exc
    return _to_detail(record)


@router.patch("/{thread_id}", response_model=ConversationListItemResponse)
async def update_conversation(
    thread_id: str,
    payload: UpdateConversationRequest,
    actor: Actor = Depends(get_current_actor),
    service: SqlAlchemyConversationAdminService | InMemoryConversationAdminService = Depends(
        get_conversation_admin_service
    ),
) -> ConversationListItemResponse:
    try:
        updated = await service.update_conversation(
            actor,
            thread_id,
            title=payload.title,
            status=payload.status,
        )
    except InvalidThreadIdError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Mã hội thoại không hợp lệ."
        ) from exc
    except ConversationForbiddenError as exc:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc)) from exc
    except ConversationValidationError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except ConversationNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Không tìm thấy hội thoại."
        ) from exc
    return _to_list_item(updated)


@router.delete("/{thread_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_conversation(
    thread_id: str,
    actor: Actor = Depends(get_current_actor),
    service: SqlAlchemyConversationAdminService | InMemoryConversationAdminService = Depends(
        get_conversation_admin_service
    ),
) -> None:
    try:
        await service.delete_conversation(actor, thread_id)
    except InvalidThreadIdError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Mã hội thoại không hợp lệ."
        ) from exc
    except ConversationForbiddenError as exc:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc)) from exc
    except ConversationNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Không tìm thấy hội thoại."
        ) from exc
