"""Agent built with LangChain's create_agent (tool loop, retries and errors from middleware)."""

import logging

import httpx
from langchain.agents import create_agent
from langchain.agents.middleware import (
    ModelRetryMiddleware,
    ToolCallRequest,
    ToolErrorMiddleware,
    ToolRetryMiddleware,
)
from langchain.chat_models import init_chat_model
from langchain_core.language_models import BaseChatModel
from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.graph.state import CompiledStateGraph

from logix_agent.config import settings
from logix_agent.modules.agent.tools import TOOLS

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = (
    "You are LogiX Copilot, an assistant for a B2B logistics platform. "
    "Reply in the language the user writes in and keep answers concise. "
    "Use the tools to read inventory and product data; never invent data. "
    "You can only read data, not change it."
)

_STATUS_MESSAGES = {
    401: "Phiên đăng nhập không hợp lệ hoặc đã hết hạn.",
    403: "Bạn không có quyền xem dữ liệu này.",
    404: "Không tìm thấy dữ liệu được yêu cầu.",
}


def on_tool_error(exc: Exception, request: ToolCallRequest) -> str:
    """Text the model sees when a tool fails; the raw exception never reaches it."""
    if isinstance(exc, httpx.HTTPStatusError):
        status = exc.response.status_code
        if status in _STATUS_MESSAGES:
            return _STATUS_MESSAGES[status]
        if status < 500:
            return "Yêu cầu không hợp lệ, hãy kiểm tra lại tham số."
        return "Dịch vụ nghiệp vụ hiện không khả dụng. Vui lòng thử lại sau."
    if isinstance(exc, httpx.TimeoutException):
        return "Dịch vụ nghiệp vụ phản hồi quá lâu. Vui lòng thử lại."
    if isinstance(exc, httpx.TransportError):
        return "Không kết nối được tới dịch vụ nghiệp vụ. Vui lòng thử lại sau."
    logger.error("Tool %s failed", request.tool_call["name"], exc_info=exc)
    return "Công cụ gặp lỗi không mong muốn. Vui lòng thử lại sau."


def on_model_failure(exc: Exception) -> str:
    # The default text names the exception and its message, and would reach the user.
    return "Mô hình AI hiện không khả dụng. Vui lòng thử lại sau."


def build_agent(
    checkpointer: BaseCheckpointSaver, model: BaseChatModel | None = None
) -> CompiledStateGraph:
    if model is None:
        model = init_chat_model(settings.agent_model, api_key=settings.gemini_api_key)
    return create_agent(
        model=model,
        tools=TOOLS,
        system_prompt=SYSTEM_PROMPT,
        checkpointer=checkpointer,
        middleware=[
            ModelRetryMiddleware(
                max_retries=2, initial_delay=1.0, on_failure=on_model_failure
            ),
            # Retry sits inside so exhausted retries still reach the error handler.
            ToolErrorMiddleware(on_error=on_tool_error),
            ToolRetryMiddleware(
                max_retries=2,
                initial_delay=0.5,
                retry_on=(httpx.TimeoutException, httpx.TransportError),
                on_failure="error",
            ),
        ],
    )
