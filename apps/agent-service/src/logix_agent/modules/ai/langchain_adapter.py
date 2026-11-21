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
from dataclasses import dataclass, field
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
from opentelemetry import trace
from pydantic import ConfigDict

from logix_agent.modules.ai.contracts import (
    FinishReason,
    ModelRequest,
    ModelResponse,
    ModelStreamChunk,
    ModelToolCall,
    ModelUsage,
    ToolDefinition,
)
from logix_agent.modules.ai.ports import ModelGateway
from logix_agent.modules.telemetry import (
    GEN_AI_OPERATION_NAME,
    GEN_AI_REQUEST_MODEL,
    GEN_AI_RESPONSE_FINISH_REASONS,
    GEN_AI_SYSTEM,
    GEN_AI_USAGE_INPUT_TOKENS,
    GEN_AI_USAGE_OUTPUT_TOKENS,
    GEN_AI_USAGE_TOTAL_TOKENS,
    LOGIX_CORRELATION_ID,
    LOGIX_EXECUTION_ID,
    LOGIX_TENANT_ID,
    get_tracer,
)

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


def _usage_of(usage: ModelUsage | None) -> UsageMetadata | None:
    if usage is None or usage.total_tokens is None:
        return None
    return UsageMetadata(
        input_tokens=usage.input_tokens or 0,
        output_tokens=usage.output_tokens or 0,
        total_tokens=usage.total_tokens,
    )


def _response_metadata(
    provider: str, model: str, finish_reason: FinishReason
) -> dict[str, str]:
    return {
        "provider": provider,
        "model": model,
        "finish_reason": finish_reason.value,
    }


def _convert_tool_calls(
    gateway_tool_calls: Sequence[ModelToolCall],
) -> tuple[list[dict[str, Any]], list[ToolCallChunk], dict[str, Any]]:
    tool_calls = [
        {
            "name": tc.name,
            "args": tc.arguments,
            "id": tc.id,
            "type": "tool_call",
        }
        for tc in gateway_tool_calls
    ]
    tool_call_chunks = [
        ToolCallChunk(
            name=tc.name,
            args=json.dumps(tc.arguments, ensure_ascii=False) if tc.arguments else "{}",
            id=tc.id,
            index=i,
        )
        for i, tc in enumerate(gateway_tool_calls)
    ]
    thought_signatures = {
        tc.id: tc.thought_signature
        for tc in gateway_tool_calls
        if tc.id and tc.thought_signature
    }
    additional_kwargs: dict[str, Any] = {}
    if thought_signatures:
        additional_kwargs["thought_signatures"] = thought_signatures
    return tool_calls, tool_call_chunks, additional_kwargs


class _GenAIChatSpanRecorder:
    """Manages ``gen_ai.chat`` span attributes, errors, and completion logging."""

    def __init__(
        self,
        request: ModelRequest,
        *,
        span: trace.Span,
        owns_span_end: bool,
    ) -> None:
        self._request = request
        self._span = span
        self._owns_span_end = owns_span_end
        self._ended = False
        self._configure_start()

    @classmethod
    def start_detached(cls, request: ModelRequest) -> _GenAIChatSpanRecorder:
        """Start a span without binding contextvars (safe across async generator yields)."""
        span = get_tracer("logix_agent.ai").start_span("gen_ai.chat", kind=trace.SpanKind.CLIENT)
        return cls(request, span=span, owns_span_end=True)

    def _configure_start(self) -> None:
        self._span.set_attribute(GEN_AI_OPERATION_NAME, "chat")
        self._span.set_attribute(GEN_AI_REQUEST_MODEL, self._request.model_profile)
        if self._request.tenant_id:
            self._span.set_attribute(LOGIX_TENANT_ID, self._request.tenant_id)
        if self._request.correlation_id:
            self._span.set_attribute(LOGIX_CORRELATION_ID, self._request.correlation_id)
        if self._request.execution_id:
            self._span.set_attribute(LOGIX_EXECUTION_ID, str(self._request.execution_id))

    def record_error(self, exc: Exception) -> None:
        self._span.record_exception(exc)
        self._span.set_status(trace.StatusCode.ERROR, str(exc))

    def record_success(
        self,
        *,
        provider: str,
        model: str | None,
        finish_reason: FinishReason,
        usage: ModelUsage | None,
        tool_call_names: Sequence[str],
        latency_ms: int | None,
    ) -> None:
        self._span.set_attribute(GEN_AI_SYSTEM, provider or "unknown")
        if model:
            self._span.set_attribute(GEN_AI_REQUEST_MODEL, model)

        finish_val = (
            finish_reason.value if hasattr(finish_reason, "value") else str(finish_reason)
        )
        self._span.set_attribute(GEN_AI_RESPONSE_FINISH_REASONS, [finish_val])

        effective_usage = usage or ModelUsage()
        if effective_usage.input_tokens is not None:
            self._span.set_attribute(GEN_AI_USAGE_INPUT_TOKENS, effective_usage.input_tokens)
        if effective_usage.output_tokens is not None:
            self._span.set_attribute(GEN_AI_USAGE_OUTPUT_TOKENS, effective_usage.output_tokens)
        if effective_usage.total_tokens is not None:
            self._span.set_attribute(GEN_AI_USAGE_TOTAL_TOKENS, effective_usage.total_tokens)

        latency_str = f"{latency_ms}ms" if latency_ms is not None else "n/a"
        tokens_str = (
            f"tokens=[in={effective_usage.input_tokens}, "
            f"out={effective_usage.output_tokens}, total={effective_usage.total_tokens}]"
            if effective_usage.total_tokens is not None
            else "tokens=n/a"
        )
        logger.info(
            "tenant=%s correlation_id=%s ModelGateway finished in %s (%s, finish_reason=%s, %d tool calls: %s)",
            self._request.tenant_id,
            self._request.correlation_id,
            latency_str,
            tokens_str,
            finish_val,
            len(tool_call_names),
            ", ".join(tool_call_names),
        )

    def end(self) -> None:
        if self._owns_span_end and not self._ended:
            self._span.end()
            self._ended = True


@dataclass
class _StreamTerminalState:
    """Collects provider metadata and tool calls while deltas stream downstream."""

    default_model: str
    provider: str = "unknown"
    model: str = ""
    finish_reason: FinishReason = FinishReason.STOP
    usage: ModelUsage | None = None
    latency_ms: int | None = None
    tool_calls: list[ModelToolCall] = field(default_factory=list)

    def __post_init__(self) -> None:
        if not self.model:
            self.model = self.default_model

    def observe(self, chunk: ModelStreamChunk) -> None:
        if chunk.provider:
            self.provider = chunk.provider
        if chunk.model:
            self.model = chunk.model
        if chunk.tool_calls:
            self.tool_calls.extend(chunk.tool_calls)
        if chunk.usage is not None:
            self.usage = chunk.usage
        if chunk.finish_reason is not None:
            self.finish_reason = chunk.finish_reason
        if chunk.latency_ms is not None:
            self.latency_ms = chunk.latency_ms

    def to_terminal_chunks(self) -> list[ChatGenerationChunk]:
        chunks: list[ChatGenerationChunk] = []
        if self.tool_calls:
            tc_dicts, tc_chunks, extra = _convert_tool_calls(self.tool_calls)
            chunks.append(
                ChatGenerationChunk(
                    message=AIMessageChunk(
                        content="",
                        tool_calls=tc_dicts,
                        tool_call_chunks=tc_chunks,
                        additional_kwargs=extra,
                    )
                )
            )
        # ag-ui-langgraph ignores any chunk carrying finish_reason, so keep it off text/tool chunks.
        chunks.append(
            ChatGenerationChunk(
                message=AIMessageChunk(
                    content="",
                    usage_metadata=_usage_of(self.usage),
                    response_metadata=_response_metadata(
                        self.provider, self.model, self.finish_reason
                    ),
                )
            )
        )
        return chunks


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

    def _prepare_gateway_call(
        self, messages: list[BaseMessage], kwargs: dict[str, Any]
    ) -> tuple[ModelRequest, list[ToolDefinition]]:
        configurable = kwargs.get("configurable") or {}
        tenant_id = kwargs.get("tenant_id") or configurable.get("tenant_id")
        correlation_id = kwargs.get("correlation_id") or configurable.get("correlation_id")
        if not tenant_id or not correlation_id:
            raise ValueError("tenant_id and correlation_id are required")

        raw_tools = kwargs.get("tools") or []
        tool_defs = _to_tool_definitions(raw_tools)

        request = ModelRequest(
            model_profile=self.model_profile,
            tenant_id=tenant_id,
            correlation_id=correlation_id,
            execution_id=kwargs.get("execution_id"),
            messages=_to_gateway_messages(messages),
            system_policy_version=self.system_policy_version,
        )
        logger.debug(
            "tenant=%s correlation_id=%s calling ModelGateway profile='%s' (%d messages, %d tools: %s)",
            tenant_id,
            correlation_id,
            self.model_profile,
            len(messages),
            len(tool_defs),
            ", ".join(t.name for t in tool_defs),
        )
        return request, tool_defs

    async def _call_gateway(
        self, messages: list[BaseMessage], kwargs: dict[str, Any]
    ) -> ModelResponse:
        request, tool_defs = self._prepare_gateway_call(messages, kwargs)
        gateway: ModelGateway = self.gateway
        active_tracer = get_tracer("logix_agent.ai")

        with active_tracer.start_as_current_span("gen_ai.chat", kind=trace.SpanKind.CLIENT) as span:
            recorder = _GenAIChatSpanRecorder(request, span=span, owns_span_end=False)
            try:
                response = await gateway.generate(request, tools=tool_defs)
            except Exception as exc:
                recorder.record_error(exc)
                raise

            recorder.record_success(
                provider=response.provider,
                model=response.model,
                finish_reason=response.finish_reason,
                usage=response.usage,
                tool_call_names=[tc.name for tc in response.tool_calls],
                latency_ms=response.latency_ms,
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
        tool_calls, _, additional_kwargs = _convert_tool_calls(response.tool_calls)

        message = AIMessage(
            content=response.content or "",
            tool_calls=tool_calls,
            additional_kwargs=additional_kwargs,
            usage_metadata=_usage_of(response.usage),
            response_metadata=_response_metadata(
                response.provider, response.model, response.finish_reason
            ),
        )
        return ChatResult(generations=[ChatGeneration(message=message)])

    async def _astream(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: AsyncCallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> AsyncIterator[ChatGenerationChunk]:
        request, tool_defs = self._prepare_gateway_call(messages, kwargs)
        gateway: ModelGateway = self.gateway
        span_recorder = _GenAIChatSpanRecorder.start_detached(request)
        state = _StreamTerminalState(default_model=self.model_profile)

        try:
            async for gw_chunk in gateway.stream(request, tools=tool_defs):
                state.observe(gw_chunk)
                if gw_chunk.content_delta:
                    text_chunk = ChatGenerationChunk(
                        message=AIMessageChunk(content=gw_chunk.content_delta)
                    )
                    if run_manager is not None:
                        await run_manager.on_llm_new_token(
                            gw_chunk.content_delta, chunk=text_chunk
                        )
                    yield text_chunk
        except Exception as exc:
            span_recorder.record_error(exc)
            raise
        else:
            span_recorder.record_success(
                provider=state.provider,
                model=state.model,
                finish_reason=state.finish_reason,
                usage=state.usage,
                tool_call_names=[tc.name for tc in state.tool_calls],
                latency_ms=state.latency_ms,
            )
        finally:
            span_recorder.end()

        for terminal_chunk in state.to_terminal_chunks():
            yield terminal_chunk
