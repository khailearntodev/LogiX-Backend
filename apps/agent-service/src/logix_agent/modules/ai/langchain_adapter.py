"""LangChain chat-model facade over the provider-agnostic ``ModelGateway`` port.

LangGraph/AG-UI derive their events from LangChain chat-model callbacks, so the
graph talks to this facade while every call still flows through ``ModelGateway``
(profiles, retry, fallback, capability checks).  Per-call identity is passed as
keyword arguments: ``tenant_id`` and ``correlation_id`` are required.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Sequence
from typing import Any

from langchain_core.callbacks import (
    AsyncCallbackManagerForLLMRun,
    CallbackManagerForLLMRun,
)
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import (
    AIMessage,
    AIMessageChunk,
    BaseMessage,
)
from langchain_core.messages.ai import UsageMetadata
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
from pydantic import ConfigDict

from logix_agent.modules.ai.contracts import ModelRequest, ModelResponse
from logix_agent.modules.ai.ports import ModelGateway

_ROLE_BY_TYPE = {
    "system": "system",
    "human": "user",
    "ai": "assistant",
    "tool": "tool",
}


def _text_of(message: BaseMessage) -> str:
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


def _to_gateway_messages(messages: Sequence[BaseMessage]) -> list[dict[str, Any]]:
    return [{"role": _ROLE_BY_TYPE.get(m.type, "user"), "content": _text_of(m)} for m in messages]


def _usage_of(response: ModelResponse) -> UsageMetadata | None:
    usage = response.usage
    if usage.total_tokens is None:
        return None
    return UsageMetadata(
        input_tokens=usage.input_tokens or 0,
        output_tokens=usage.output_tokens or 0,
        total_tokens=usage.total_tokens,
    )


class ModelGatewayChatModel(BaseChatModel):
    """Chat model whose calls are served by a ``ModelGateway``."""

    gateway: Any
    model_profile: str = "planner-default"
    system_policy_version: str = "v1"

    model_config = ConfigDict(arbitrary_types_allowed=True)

    @property
    def _llm_type(self) -> str:
        return "logix-model-gateway"

    async def _call_gateway(
        self, messages: list[BaseMessage], kwargs: dict[str, Any]
    ) -> ModelResponse:
        configurable = kwargs.get("configurable") or {}
        tenant_id = kwargs.get("tenant_id") or configurable.get("tenant_id")
        correlation_id = kwargs.get("correlation_id") or configurable.get("correlation_id")
        if not tenant_id or not correlation_id:
            raise ValueError("tenant_id and correlation_id are required")
        gateway: ModelGateway = self.gateway
        request = ModelRequest(
            model_profile=self.model_profile,
            tenant_id=tenant_id,
            correlation_id=correlation_id,
            execution_id=kwargs.get("execution_id"),
            messages=_to_gateway_messages(messages),
            system_policy_version=self.system_policy_version,
        )
        return await gateway.generate(request)

    def _generate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: CallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> ChatResult:
        raise NotImplementedError("ModelGatewayChatModel is async-only")

    async def _agenerate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: AsyncCallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> ChatResult:
        response = await self._call_gateway(messages, kwargs)
        message = AIMessage(
            content=response.content or "",
            usage_metadata=_usage_of(response),
            response_metadata={
                "provider": response.provider,
                "model": response.model,
                "finish_reason": response.finish_reason.value,
            },
        )
        return ChatResult(generations=[ChatGeneration(message=message)])

    async def _astream(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: AsyncCallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> AsyncIterator[ChatGenerationChunk]:
        # The gateway has no streaming yet: emit the whole answer as one text chunk.
        response = await self._call_gateway(messages, kwargs)
        text = response.content or ""
        if text:
            chunk = ChatGenerationChunk(message=AIMessageChunk(content=text))
            if run_manager is not None:
                await run_manager.on_llm_new_token(text, chunk=chunk)
            yield chunk
        # ag-ui-langgraph ignores any chunk carrying finish_reason, so keep it off the text chunk.
        yield ChatGenerationChunk(
            message=AIMessageChunk(
                content="",
                usage_metadata=_usage_of(response),
                response_metadata={
                    "provider": response.provider,
                    "model": response.model,
                    "finish_reason": response.finish_reason.value,
                },
            )
        )
