"""Single-node chat graph: system prompt + conversation history -> ModelGateway."""

from __future__ import annotations

import logging

from langchain_core.messages import SystemMessage
from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.graph import END, START, MessagesState, StateGraph
from langgraph.graph.state import CompiledStateGraph

from logix_agent.modules.ai.errors import (
    FallbackExhaustedError,
    ModelGatewayError,
    ModelRateLimitError,
    ModelTimeoutError,
    ModelUnavailableError,
)
from logix_agent.modules.ai.langchain_adapter import ModelGatewayChatModel
from logix_agent.modules.ai.ports import ModelGateway

logger = logging.getLogger(__name__)

MAX_HISTORY_MESSAGES = 40

SYSTEM_PROMPT = (
    "You are LogiX Copilot, an assistant for a B2B logistics platform. "
    "Reply in the language the user writes in and keep answers concise. "
    "You cannot yet read business data or perform actions; if asked to, say so "
    "instead of guessing."
)

MODEL_TIMEOUT = "MODEL_TIMEOUT"
MODEL_UNAVAILABLE = "MODEL_UNAVAILABLE"
INTERNAL = "INTERNAL"

PUBLIC_MESSAGES = {
    MODEL_TIMEOUT: "Mô hình AI phản hồi quá lâu. Vui lòng thử lại.",
    MODEL_UNAVAILABLE: "Mô hình AI hiện không khả dụng. Vui lòng thử lại sau.",
    INTERNAL: "Đã xảy ra lỗi khi xử lý yêu cầu.",
}


class ChatRunError(Exception):
    """Run failure carrying a stable code; ``str()`` is parsed by the AG-UI router."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(f"[{code}] {PUBLIC_MESSAGES[code]}")


def _classify(exc: ModelGatewayError) -> str:
    if isinstance(exc, ModelTimeoutError):
        return MODEL_TIMEOUT
    if isinstance(exc, (ModelRateLimitError, ModelUnavailableError, FallbackExhaustedError)):
        return MODEL_UNAVAILABLE
    return INTERNAL


def build_chat_graph(
    gateway: ModelGateway,
    *,
    checkpointer: BaseCheckpointSaver,
    prompt_policy_version: str = "v1",
) -> CompiledStateGraph:
    model = ModelGatewayChatModel(gateway=gateway, system_policy_version=prompt_policy_version)

    async def chat(state: MessagesState, config: RunnableConfig) -> dict:
        configurable = config.get("configurable", {})
        tenant_id = configurable.get("tenant_id")
        correlation_id = configurable.get("correlation_id")
        if not tenant_id or not correlation_id:
            raise ChatRunError(INTERNAL)

        history = state["messages"][-MAX_HISTORY_MESSAGES:]
        try:
            reply = await model.ainvoke(
                [SystemMessage(content=SYSTEM_PROMPT), *history],
                config,
                tenant_id=tenant_id,
                correlation_id=correlation_id,
            )
        except ModelGatewayError as exc:
            logger.warning("Model call failed (correlation_id=%s): %s", correlation_id, exc)
            raise ChatRunError(_classify(exc)) from exc
        return {"messages": [reply]}

    builder = StateGraph(MessagesState)
    builder.add_node("chat", chat)
    builder.add_edge(START, "chat")
    builder.add_edge("chat", END)
    return builder.compile(checkpointer=checkpointer)
