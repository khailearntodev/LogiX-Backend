"""Cross-thread long-term memory helpers scoped strictly by tenant and user."""

from __future__ import annotations

import logging
import re
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from langchain_core.messages import BaseMessage, SystemMessage
from langgraph.store.base import BaseStore, Item

from logix_agent.modules.auth import Actor
from logix_agent.modules.registry.spec import ToolContext

if TYPE_CHECKING:
    from logix_agent.modules.tools.http_client import ServiceClient

logger = logging.getLogger(__name__)

PROFILE_KEY = "info"
MAX_MEMORY_KEY_LENGTH = 64
MAX_MEMORY_CONTENT_LENGTH = 500
VALID_MEMORY_CATEGORIES = frozenset({"preference", "rule", "fact"})
_KEY_NORMALIZE_RE = re.compile(r"[^a-z0-9_-]+")
_MIN_DT = datetime.min.replace(tzinfo=UTC)


def _require_actor_scope(tenant_id: str, user_id: str) -> tuple[str, str]:
    t_id = str(tenant_id).strip()
    u_id = str(user_id).strip()
    if not t_id or not u_id:
        raise ValueError("tenant_id and user_id are required for memory isolation")
    return t_id, u_id


def user_profile_namespace(tenant_id: str, user_id: str) -> tuple[str, ...]:
    """Return the tenant- and user-isolated namespace for cached actor profile context."""
    t_id, u_id = _require_actor_scope(tenant_id, user_id)
    return ("tenant", t_id, "user", u_id, "profile")


def user_memories_namespace(tenant_id: str, user_id: str) -> tuple[str, ...]:
    """Return the tenant- and user-isolated namespace for user preferences and notes."""
    t_id, u_id = _require_actor_scope(tenant_id, user_id)
    return ("tenant", t_id, "user", u_id, "memories")


def normalize_memory_key(raw_key: str) -> str:
    """Normalize a memory key into a compact, deterministic ASCII slug."""
    cleaned = _KEY_NORMALIZE_RE.sub("_", raw_key.strip().lower()).strip("_-")
    if not cleaned:
        raise ValueError("Memory key must contain at least one letter or digit.")
    return cleaned[:MAX_MEMORY_KEY_LENGTH]


def sanitize_memory_content(raw_content: str) -> str:
    """Trim and validate memory content length before persisting."""
    cleaned = " ".join(raw_content.split())
    if not cleaned:
        raise ValueError("Memory content must not be empty.")
    if len(cleaned) > MAX_MEMORY_CONTENT_LENGTH:
        raise ValueError(
            f"Memory content exceeds maximum length of {MAX_MEMORY_CONTENT_LENGTH} characters."
        )
    return cleaned


def sort_memory_items(items: Sequence[Item]) -> list[Item]:
    """Order store items deterministically from most recently updated to oldest."""
    return sorted(items, key=lambda item: item.updated_at or _MIN_DT, reverse=True)


def sanitize_profile_payload(raw: Mapping[str, Any], actor: Actor) -> dict[str, str]:
    """Keep only non-PII operational context from identity-service profile responses."""
    active_tenant = raw.get("activeTenant")
    tenant_map = active_tenant if isinstance(active_tenant, Mapping) else {}

    profile: dict[str, str] = {}
    display_name = raw.get("displayName")
    if isinstance(display_name, str) and display_name.strip():
        profile["display_name"] = display_name.strip()[:120]

    role = tenant_map.get("role") or actor.role
    if isinstance(role, str) and role.strip():
        profile["role"] = role.strip()[:60]

    tenant_code = tenant_map.get("code")
    if isinstance(tenant_code, str) and tenant_code.strip():
        profile["tenant_code"] = tenant_code.strip()[:60]

    tenant_name = tenant_map.get("name")
    if isinstance(tenant_name, str) and tenant_name.strip():
        profile["tenant_name"] = tenant_name.strip()[:120]

    return profile


async def ensure_user_profile(
    store: BaseStore,
    actor: Actor,
    *,
    service_client: ServiceClient | None = None,
    correlation_id: str = "",
) -> dict[str, str]:
    """Load cached non-PII user profile from store, lazily syncing once via /api/v1/auth/me."""
    if not actor.tenant_id or not actor.user_id:
        return {}

    namespace = user_profile_namespace(actor.tenant_id, actor.user_id)
    cached = await store.aget(namespace, PROFILE_KEY)
    if cached is not None and isinstance(cached.value, Mapping):
        return {
            str(k): str(v)
            for k, v in cached.value.items()
            if isinstance(v, str) and v.strip()
        }

    if service_client is not None and actor.access_token:
        ctx = ToolContext(actor=actor, correlation_id=correlation_id)
        try:
            raw = await service_client.request("identity", "GET", "/api/v1/auth/me", ctx)
            if isinstance(raw, Mapping):
                profile = sanitize_profile_payload(raw, actor)
                if profile:
                    await store.aput(namespace, PROFILE_KEY, profile)
                    return profile
        except Exception as exc:
            logger.debug(
                "Could not sync user profile from identity-service for user=%s: %s",
                actor.user_id,
                exc,
            )

    return {"role": actor.role} if actor.role else {}


def _format_profile_line(profile: Mapping[str, str]) -> str | None:
    if not profile:
        return None
    parts: list[str] = []
    if profile.get("display_name"):
        parts.append(f"Name={profile['display_name']}")
    if profile.get("role"):
        parts.append(f"Role={profile['role']}")
    tenant_name = profile.get("tenant_name")
    tenant_code = profile.get("tenant_code")
    if tenant_name and tenant_code:
        parts.append(f"Organization={tenant_name} ({tenant_code})")
    elif tenant_name or tenant_code:
        parts.append(f"Organization={tenant_name or tenant_code}")
    return f"User context: {', '.join(parts)}" if parts else None


async def load_memory_context_block(
    store: BaseStore | None,
    actor: Actor,
    *,
    service_client: ServiceClient | None = None,
    correlation_id: str = "",
    max_items: int = 15,
    max_chars: int = 1500,
) -> str:
    """Build a bounded long-term memory block for system prompt injection."""
    if store is None or not actor.tenant_id or not actor.user_id:
        return ""

    profile = await ensure_user_profile(
        store, actor, service_client=service_client, correlation_id=correlation_id
    )
    items = sort_memory_items(
        await store.asearch(
            user_memories_namespace(actor.tenant_id, actor.user_id),
            limit=max(max_items * 2, 30),
        )
    )[:max_items]

    lines: list[str] = []
    profile_line = _format_profile_line(profile)
    if profile_line:
        lines.append(profile_line)

    if items:
        lines.append("Saved preferences & notes:")
        for item in items:
            value = item.value if isinstance(item.value, Mapping) else {}
            content = str(value.get("content", "")).strip()
            if not content:
                continue
            category = str(value.get("category", "note")).strip() or "note"
            lines.append(f"- [{category}] {item.key}: {content}")

    if not lines:
        return ""

    header = "[USER LONG-TERM MEMORY]"
    footer = "[/USER LONG-TERM MEMORY]"
    budget = max(0, max_chars - len(header) - len(footer) - 2)
    selected: list[str] = []
    used = 0
    for line in lines:
        cost = len(line) + (1 if selected else 0)
        if used + cost > budget:
            break
        selected.append(line)
        used += cost

    if not selected:
        return ""
    return "\n".join([header, *selected, footer])


def _message_text(message: BaseMessage) -> str:
    content = message.content
    if isinstance(content, str):
        return content
    parts: list[str] = []
    for block in content:
        if isinstance(block, str):
            parts.append(block)
        elif isinstance(block, dict) and block.get("type") == "text":
            parts.append(str(block.get("text", "")))
    return "".join(parts)


def inject_memory_context(history: list[BaseMessage], memory_block: str) -> list[BaseMessage]:
    """Attach long-term memory into the leading SystemMessage without mutating state."""
    if not memory_block:
        return history
    if history and isinstance(history[0], SystemMessage):
        base = _message_text(history[0])
        merged = f"{base}\n\n{memory_block}" if base else memory_block
        return [SystemMessage(content=merged), *history[1:]]
    return [SystemMessage(content=memory_block), *history]
