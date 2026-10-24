"""LangChain chat-model facade over the provider-agnostic ``ModelGateway`` port.

LangGraph/AG-UI derive their events from LangChain chat-model callbacks, so the
graph talks to this facade while every call still flows through ``ModelGateway``
(profiles, retry, fallback, capability checks).  Per-call identity is passed as
keyword arguments: ``tenant_id`` and ``correlation_id`` are required.
"""

from __future__ import annotations

import json
import logging
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
    ToolMessage,
)
from langchain_core.messages.ai import UsageMetadata
from langchain_core.messages.tool import ToolCallChunk
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
from pydantic import ConfigDict

from logix_agent.modules.ai.contracts import ModelRequest, ModelResponse, ToolDefinition
from logix_agent.modules.ai.ports import ModelGateway

logger = logging.getLogger(__name__)

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
    result = []
    for m in messages:
        role = _ROLE_BY_TYPE.get(m.type, "user")
        msg_dict: dict[str, Any] = {"role": role, "content": _text_of(m)}
        if isinstance(m, AIMessage) and m.tool_calls:
            sigs = m.additional_kwargs.get("thought_signatures") or {}
            msg_dict["tool_calls"] = []
            for idx, tc in enumerate(m.tool_calls):
                tc_id = tc.get("id")
                sig = (
                    sigs.get(tc_id)
                    or sigs.get(str(idx))
                    or (list(sigs.values())[idx] if idx < len(sigs) else None)
                )
                msg_dict["tool_calls"].append(
                    {
                        "name": tc["name"],
                        "arguments": tc.get("args") or {},
                        "id": tc_id,
                        "thought_signature": sig,
                    }
                )
        elif isinstance(m, ToolMessage):
            msg_dict["name"] = m.name or "tool_result"
            if getattr(m, "tool_call_id", None):
                msg_dict["tool_call_id"] = m.tool_call_id
        result.append(msg_dict)
    return result


def _clean_schema(schema: dict[str, Any]) -> dict[str, Any]:
    """Dereference $defs and strip titles/unsupported fields for LLM function declarations."""
    defs = schema.get("$defs") or schema.get("definitions") or {}

    def _resolve(node: Any) -> Any:
        if isinstance(node, dict):
            if "$ref" in node and isinstance(node["$ref"], str):
                ref_name = node["$ref"].split("/")[-1]
                if ref_name in defs:
                    resolved = _resolve(defs[ref_name].copy())
                    extra = {k: _resolve(v) for k, v in node.items() if k != "$ref"}
                    return {**resolved, **extra}
            return {
                k: _resolve(v)
                for k, v in node.items()
                if k not in ("title", "$defs", "definitions")
            }
        if isinstance(node, list):
            return [_resolve(item) for item in node]
        return node

    cleaned = _resolve(schema)
    if isinstance(cleaned, dict):
        cleaned.pop("$defs", None)
        cleaned.pop("definitions", None)
        cleaned.pop("title", None)
    return cleaned


def _to_tool_definitions(tools: Sequence[Any]) -> list[ToolDefinition]:
    """Convert LangChain StructuredTools or specs to provider-agnostic ToolDefinition."""
    defs: list[ToolDefinition] = []
    for t in tools:
        if isinstance(t, ToolDefinition):
            defs.append(t)
        elif hasattr(t, "name") and hasattr(t, "description"):
            schema: dict[str, Any] = {}
            if hasattr(t, "args_schema") and t.args_schema is not None:
                if hasattr(t.args_schema, "model_json_schema"):
                    schema = _clean_schema(t.args_schema.model_json_schema())
                elif hasattr(t.args_schema, "schema"):
                    schema = _clean_schema(t.args_schema.schema())
            defs.append(
                ToolDefinition(
                    name=t.name,
                    description=t.description or "",
                    input_schema=schema,
                )
            )
        elif isinstance(t, dict):
            name = t.get("name") or t.get("function", {}).get("name", "")
            desc = t.get("description") or t.get("function", {}).get("description", "")
            schema = t.get("parameters") or t.get("function", {}).get("parameters") or {}
            defs.append(
                ToolDefinition(
                    name=name,
                    description=desc,
                    input_schema=_clean_schema(schema),
                )
            )
    return defs


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

    def bind_tools(
        self,
        tools: Sequence[Any],
        **kwargs: Any,
    ) -> Any:
        return self.bind(tools=tools, **kwargs)

    async def _call_gateway(
        self, messages: list[BaseMessage], kwargs: dict[str, Any]
    ) -> ModelResponse:
        configurable = kwargs.get("configurable") or {}
        tenant_id = kwargs.get("tenant_id") or configurable.get("tenant_id")
        correlation_id = kwargs.get("correlation_id") or configurable.get("correlation_id")
        if not tenant_id or not correlation_id:
            raise ValueError("tenant_id and correlation_id are required")

        raw_tools = kwargs.get("tools") or []
        tool_defs = _to_tool_definitions(raw_tools)

        gateway: ModelGateway = self.gateway
        request = ModelRequest(
            model_profile=self.model_profile,
            tenant_id=tenant_id,
            correlation_id=correlation_id,
            execution_id=kwargs.get("execution_id"),
            messages=_to_gateway_messages(messages),
            system_policy_version=self.system_policy_version,
        )
        logger.info(
            "tenant=%s correlation_id=%s calling ModelGateway profile='%s' (%d messages, %d tools: %s)",
            tenant_id,
            correlation_id,
            self.model_profile,
            len(messages),
            len(tool_defs),
            ", ".join(t.name for t in tool_defs),
        )
        response = await gateway.generate(request, tools=tool_defs)
        finish_val = (
            response.finish_reason.value
            if hasattr(response.finish_reason, "value")
            else str(response.finish_reason)
        )
        latency_str = f"{response.latency_ms}ms" if response.latency_ms is not None else "n/a"
        logger.info(
            "tenant=%s correlation_id=%s ModelGateway finished in %s (finish_reason=%s, %d tool calls: %s)",
            tenant_id,
            correlation_id,
            latency_str,
            finish_val,
            len(response.tool_calls),
            ", ".join(tc.name for tc in response.tool_calls),
        )
        return response

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
        tool_calls = [
            {
                "name": tc.name,
                "args": tc.arguments,
                "id": tc.id,
                "type": "tool_call",
            }
            for tc in response.tool_calls
        ]
        thought_signatures = {
            tc.id: tc.thought_signature
            for tc in response.tool_calls
            if tc.id and tc.thought_signature
        }
        additional_kwargs = {}
        if thought_signatures:
            additional_kwargs["thought_signatures"] = thought_signatures

        message = AIMessage(
            content=response.content or "",
            tool_calls=tool_calls,
            additional_kwargs=additional_kwargs,
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
        response = await self._call_gateway(messages, kwargs)
        text = response.content or ""
        tool_calls = [
            {
                "name": tc.name,
                "args": tc.arguments,
                "id": tc.id,
                "type": "tool_call",
            }
            for tc in response.tool_calls
        ]
        tool_call_chunks = [
            ToolCallChunk(
                name=tc.name,
                args=json.dumps(tc.arguments, ensure_ascii=False) if tc.arguments else "{}",
                id=tc.id,
                index=i,
            )
            for i, tc in enumerate(response.tool_calls)
        ]
        thought_signatures = {
            tc.id: tc.thought_signature
            for tc in response.tool_calls
            if tc.id and tc.thought_signature
        }
        additional_kwargs = {}
        if thought_signatures:
            additional_kwargs["thought_signatures"] = thought_signatures

        if text:
            chunk = ChatGenerationChunk(
                message=AIMessageChunk(
                    content=text,
                    tool_calls=tool_calls,
                    tool_call_chunks=tool_call_chunks,
                    additional_kwargs=additional_kwargs,
                )
            )
            if run_manager is not None:
                await run_manager.on_llm_new_token(text, chunk=chunk)
            yield chunk
        elif tool_calls:
            chunk = ChatGenerationChunk(
                message=AIMessageChunk(
                    content="",
                    tool_calls=tool_calls,
                    tool_call_chunks=tool_call_chunks,
                    additional_kwargs=additional_kwargs,
                )
            )
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
