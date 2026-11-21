"""Focused recorder for user/assistant conversation messages and buffers."""

from __future__ import annotations

import logging
from collections.abc import Sequence
from typing import Any

from logix_agent.modules.conversations.service import ThreadStore

logger = logging.getLogger(__name__)


def extract_message_text(content: object) -> str:
    """Normalise plain string or structured block lists into plain text."""
    if isinstance(content, str):
        return content
    if isinstance(content, Sequence) and not isinstance(content, (bytes, bytearray)):
        parts: list[str] = []
        for item in content:
            text = item.get("text") if isinstance(item, dict) else getattr(item, "text", None)
            if isinstance(text, str) and text:
                parts.append(text)
        return "\n".join(parts)
    return ""


def extract_latest_user_message(messages: Sequence[Any]) -> tuple[str | None, str | None]:
    """Return ``(model_message_id, content)`` for the newest non-blank user message."""
    for message in reversed(messages):
        role = message.get("role") if isinstance(message, dict) else getattr(message, "role", None)
        if role != "user":
            continue
        msg_id = message.get("id") if isinstance(message, dict) else getattr(message, "id", None)
        raw_content = (
            message.get("content") if isinstance(message, dict) else getattr(message, "content", None)
        )
        text = extract_message_text(raw_content)
        if text.strip():
            return (str(msg_id) if msg_id else None), text
    return None, None


class AssistantChunkBuffer:
    """In-memory buffer collecting streamed assistant text deltas per message ID."""

    def __init__(self, *, fallback_message_id: str) -> None:
        self._fallback_message_id = fallback_message_id
        self._chunks_by_id: dict[str, list[str]] = {}

    def append_delta(self, delta: object, *, message_id: object = None) -> None:
        if isinstance(delta, str) and delta:
            msg_id = str(message_id or self._fallback_message_id)
            self._chunks_by_id.setdefault(msg_id, []).append(delta)

    def completed_messages(self) -> list[tuple[str, str]]:
        """Return non-blank ``(model_message_id, full_text)`` pairs in arrival order."""
        completed: list[tuple[str, str]] = []
        for msg_id, parts in self._chunks_by_id.items():
            text = "".join(parts)
            if text.strip():
                completed.append((msg_id, text))
        return completed


class ConversationRecorder:
    """Persist completed user and assistant turn messages to ``ThreadStore``."""

    def __init__(self, threads: ThreadStore) -> None:
        self._threads = threads

    async def record_user_message(
        self,
        *,
        tenant_id: str,
        thread_id: str,
        messages: Sequence[Any],
    ) -> None:
        """Persist the latest user message in a turn before streaming begins."""
        user_msg_id, user_text = extract_latest_user_message(messages)
        if not user_text:
            return
        await self._threads.record_message(
            tenant_id=tenant_id,
            thread_id=thread_id,
            role="USER",
            content=user_text,
            model_message_id=user_msg_id,
        )

    def new_assistant_buffer(self, *, fallback_message_id: str) -> AssistantChunkBuffer:
        """Create a per-run buffer for accumulating streamed assistant text deltas."""
        return AssistantChunkBuffer(fallback_message_id=fallback_message_id)

    async def record_completed_assistant_message(
        self,
        *,
        tenant_id: str,
        thread_id: str,
        buffer: AssistantChunkBuffer,
        tag: str = "",
    ) -> None:
        """Persist completed assistant messages; swallows errors after stream delivery."""
        for msg_id, text in buffer.completed_messages():
            try:
                await self._threads.record_message(
                    tenant_id=tenant_id,
                    thread_id=thread_id,
                    role="ASSISTANT",
                    content=text,
                    model_message_id=msg_id,
                )
            except Exception:
                prefix = f"{tag} " if tag else ""
                logger.exception("%sfailed to record assistant message %s", prefix, msg_id)
