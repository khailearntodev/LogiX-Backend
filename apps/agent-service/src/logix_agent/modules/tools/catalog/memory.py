"""Cross-thread user long-term memory tools backed by LangGraph BaseStore."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Literal

from langgraph.store.base import BaseStore
from pydantic import BaseModel, Field

from logix_agent.modules.planner.memory import (
    MAX_MEMORY_CONTENT_LENGTH,
    MAX_MEMORY_KEY_LENGTH,
    normalize_memory_key,
    sanitize_memory_content,
    sort_memory_items,
    user_memories_namespace,
)
from logix_agent.modules.registry import RiskLevel, ToolContext, ToolError, ToolRegistry, ToolSpec

TOOL_MEMORY_UNAVAILABLE = "MEMORY_UNAVAILABLE"
TOOL_INVALID_REQUEST = "TOOL_INVALID_REQUEST"


class SaveUserMemoryIn(BaseModel):
    key: str = Field(
        ...,
        min_length=1,
        max_length=MAX_MEMORY_KEY_LENGTH,
        description=(
            "Short topic key for this memory (e.g. 'default_warehouse', "
            "'working_region', 'approval_preference')."
        ),
    )
    content: str = Field(
        ...,
        min_length=1,
        max_length=MAX_MEMORY_CONTENT_LENGTH,
        description=(
            "Concise preference, recurring workflow rule, or role context to remember "
            "across conversation threads."
        ),
    )
    category: Literal["preference", "rule", "fact"] = Field(
        "preference",
        description="Category of the long-term memory item.",
    )


class SaveUserMemoryOut(BaseModel):
    key: str
    content: str
    category: str
    saved: bool


class GetUserMemoriesIn(BaseModel):
    limit: int = Field(
        20,
        ge=1,
        le=50,
        description="Maximum number of saved memories to retrieve.",
    )


class UserMemoryEntry(BaseModel):
    key: str
    content: str
    category: str
    updated_at: str | None = None


class GetUserMemoriesOut(BaseModel):
    items: list[UserMemoryEntry]
    total: int


class DeleteUserMemoryIn(BaseModel):
    key: str = Field(
        ...,
        min_length=1,
        max_length=MAX_MEMORY_KEY_LENGTH,
        description="Topic key of the saved memory to delete.",
    )


class DeleteUserMemoryOut(BaseModel):
    key: str
    deleted: bool


def _require_store_and_namespace(ctx: ToolContext) -> tuple[BaseStore, tuple[str, ...]]:
    store = ctx.store
    if not isinstance(store, BaseStore):
        raise ToolError(TOOL_MEMORY_UNAVAILABLE, "Bộ nhớ dài hạn hiện chưa được kích hoạt.")
    try:
        namespace = user_memories_namespace(ctx.actor.tenant_id, ctx.actor.user_id)
    except ValueError as exc:
        raise ToolError(TOOL_INVALID_REQUEST, str(exc)) from None
    return store, namespace


def register(registry: ToolRegistry) -> None:
    async def handle_save_user_memory(ctx: ToolContext, args: BaseModel) -> BaseModel:
        assert isinstance(args, SaveUserMemoryIn)
        store, namespace = _require_store_and_namespace(ctx)
        try:
            key = normalize_memory_key(args.key)
            content = sanitize_memory_content(args.content)
        except ValueError as exc:
            raise ToolError(TOOL_INVALID_REQUEST, str(exc)) from None

        await store.aput(
            namespace,
            key,
            {"content": content, "category": args.category},
        )
        return SaveUserMemoryOut(key=key, content=content, category=args.category, saved=True)

    async def handle_get_user_memories(ctx: ToolContext, args: BaseModel) -> BaseModel:
        assert isinstance(args, GetUserMemoriesIn)
        store, namespace = _require_store_and_namespace(ctx)
        items = sort_memory_items(await store.asearch(namespace, limit=args.limit))
        entries: list[UserMemoryEntry] = []
        for item in items:
            value = item.value if isinstance(item.value, Mapping) else {}
            content = str(value.get("content", "")).strip()
            if not content:
                continue
            entries.append(
                UserMemoryEntry(
                    key=item.key,
                    content=content,
                    category=str(value.get("category", "preference")),
                    updated_at=item.updated_at.isoformat() if item.updated_at else None,
                )
            )
        return GetUserMemoriesOut(items=entries, total=len(entries))

    async def handle_delete_user_memory(ctx: ToolContext, args: BaseModel) -> BaseModel:
        assert isinstance(args, DeleteUserMemoryIn)
        store, namespace = _require_store_and_namespace(ctx)
        try:
            key = normalize_memory_key(args.key)
        except ValueError as exc:
            raise ToolError(TOOL_INVALID_REQUEST, str(exc)) from None

        existing = await store.aget(namespace, key)
        if existing is None:
            return DeleteUserMemoryOut(key=key, deleted=False)
        await store.adelete(namespace, key)
        return DeleteUserMemoryOut(key=key, deleted=True)

    registry.register(
        ToolSpec(
            name="save_user_memory",
            description=(
                "Save a durable preference, assigned warehouse, or recurring workflow rule for "
                "the current user so it is remembered across future conversation threads. Do not "
                "store single-order transient details, secrets, or tokens."
            ),
            input_model=SaveUserMemoryIn,
            output_model=SaveUserMemoryOut,
            handler=handle_save_user_memory,
            required_permission=None,
            risk_level=RiskLevel.READ,
            target_service="agent",
        )
    )

    registry.register(
        ToolSpec(
            name="get_user_memories",
            description=(
                "List the current user's saved cross-thread preferences, role notes, and rules."
            ),
            input_model=GetUserMemoriesIn,
            output_model=GetUserMemoriesOut,
            handler=handle_get_user_memories,
            required_permission=None,
            risk_level=RiskLevel.READ,
            target_service="agent",
        )
    )

    registry.register(
        ToolSpec(
            name="delete_user_memory",
            description=(
                "Remove a previously saved user preference or note by key when the user asks to "
                "forget or replace an outdated setting."
            ),
            input_model=DeleteUserMemoryIn,
            output_model=DeleteUserMemoryOut,
            handler=handle_delete_user_memory,
            required_permission=None,
            risk_level=RiskLevel.READ,
            target_service="agent",
        )
    )
