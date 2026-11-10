"""Context window trimming for planner conversation history.

Protects against context length exceeded errors by trimming older messages before
calling the model, while preserving:
1. System prompt at index 0.
2. The integrity of AIMessage(tool_calls) <-> ToolMessage pairs so providers
   never receive orphan tool results.
3. Checkpoint persistence: trimming only affects the list passed to the model,
   the full thread history remains intact in checkpoints.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence

from langchain_core.messages import (
    AIMessage,
    BaseMessage,
    SystemMessage,
    ToolMessage,
    trim_messages,
)
from langchain_core.messages.utils import count_tokens_approximately

logger = logging.getLogger(__name__)

DEFAULT_MAX_CONTEXT_TOKENS = 12000
DEFAULT_MAX_HISTORY_MESSAGES = 30


def _repair_orphan_tool_messages(
    trimmed: list[BaseMessage], original: Sequence[BaseMessage]
) -> list[BaseMessage]:
    """Ensure no ToolMessage appears without its preceding AIMessage(tool_calls)."""
    if not trimmed:
        return trimmed

    # Skip initial SystemMessage if present
    start_idx = 1 if isinstance(trimmed[0], SystemMessage) else 0

    # Look for any ToolMessage at the front of non-system messages
    while start_idx < len(trimmed) and isinstance(trimmed[start_idx], ToolMessage):
        orphan: ToolMessage = trimmed[start_idx]
        call_id = orphan.tool_call_id
        # Find the matching AIMessage in the original sequence
        caller = next(
            (
                m
                for m in original
                if isinstance(m, AIMessage)
                and m.tool_calls
                and any(tc.get("id") == call_id for tc in m.tool_calls)
            ),
            None,
        )
        if caller is not None:
            trimmed.insert(start_idx, caller)
            break
        else:
            # Cannot find caller; remove orphan tool message to prevent 400 provider error
            logger.warning("Dropping orphan ToolMessage (id=%s) with no matching AIMessage", call_id)
            trimmed.pop(start_idx)

    return trimmed


def trim_conversation_history(
    messages: Sequence[BaseMessage],
    *,
    max_tokens: int = DEFAULT_MAX_CONTEXT_TOKENS,
    max_messages: int = DEFAULT_MAX_HISTORY_MESSAGES,
) -> list[BaseMessage]:
    """Trim messages to fit within model context limits.

    Uses `trim_messages` with approximate token counting, strategy="last",
    and post-processes to repair any fractured tool call pairs.
    """
    if not messages:
        return []

    # If count is within limit and approximate tokens fit, return copy unchanged
    msg_list = list(messages)
    approx_tokens = count_tokens_approximately(msg_list)
    if len(msg_list) <= max_messages and approx_tokens <= max_tokens:
        return msg_list

    logger.info(
        "Trimming conversation history: %d messages, ~%d tokens (limits: max_messages=%d, max_tokens=%d)",
        len(msg_list),
        approx_tokens,
        max_messages,
        max_tokens,
    )

    trimmed = trim_messages(
        msg_list,
        max_tokens=max_tokens,
        token_counter=count_tokens_approximately,
        strategy="last",
        include_system=True,
        allow_partial=False,
        start_on=("human", "ai"),
    )

    # If message count still exceeds max_messages, take system message + last (max_messages - 1)
    if len(trimmed) > max_messages:
        sys_msg = [m for m in trimmed if isinstance(m, SystemMessage)]
        non_sys = [m for m in trimmed if not isinstance(m, SystemMessage)]
        keep_count = max_messages - len(sys_msg)
        trimmed = sys_msg + non_sys[-keep_count:]

    repaired = _repair_orphan_tool_messages(trimmed, msg_list)
    logger.info("Trimmed conversation history down to %d messages", len(repaired))
    return repaired

