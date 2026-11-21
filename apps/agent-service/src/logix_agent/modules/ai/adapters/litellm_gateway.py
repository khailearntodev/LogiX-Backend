"""LiteLLM adapter for the ModelGateway port.

This adapter implements the ``ModelGateway`` protocol using the LiteLLM
Python SDK, providing unified access to 100+ LLM providers (OpenAI,
Anthropic, Azure OpenAI, Google, Ollama, etc.) through a single interface.

It is a *pure* provider adapter:

* Text generation and structured output
* Function / tool calling
* Token usage tracking
* Profile lookup via ``ModelProfileRegistry``
* Mapping LiteLLM exceptions to LogiX ``ModelGatewayError`` hierarchy

Capability validation, bounded retry and fallback chaining are provider-agnostic
and live in ``logix_agent.modules.ai.policies``.

Design reference: ``ai-services-technical-design.md`` §8.5, §20.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncIterator, Sequence
from typing import Any

import litellm
from litellm import ModelResponse as LiteLLMModelResponse

from logix_agent.modules.ai.contracts import (
    FinishReason,
    ModelProfile,
    ModelRequest,
    ModelResponse,
    ModelStreamChunk,
    ModelToolCall,
    ModelUsage,
    ToolDefinition,
)
from logix_agent.modules.ai.errors import (
    ModelGatewayError,
    ModelRateLimitError,
    ModelTimeoutError,
    ModelUnavailableError,
)
from logix_agent.modules.ai.ports import ModelProfileRegistry

GATEWAY_BACKEND = "litellm_sdk"


class LiteLLMModelGateway:
    """Concrete ModelGateway that delegates to LiteLLM SDK.

    LiteLLM normalises API calls across providers.  The adapter maps
    internal ``ModelProfile.model`` (e.g. ``openai/gpt-4o``,
    ``anthropic/claude-sonnet-4-20250514``, ``ollama/llama3``) to the identifier
    LiteLLM expects, calls ``litellm.acompletion()``, and returns a
    normalised ``ModelResponse``.

    Parameters
    ----------
    profile_registry:
        Registry for resolving logical profile names (e.g. ``planner-default``)
        to model configurations.
    api_key:
        Optional default API key.  Provider-specific keys should be set via
        environment variables (``OPENAI_API_KEY``, ``ANTHROPIC_API_KEY``, etc.)
        as documented by LiteLLM.
    """

    def __init__(
        self,
        *,
        profile_registry: ModelProfileRegistry,
        api_key: str | None = None,
    ) -> None:
        self._profile_registry = profile_registry
        self._api_key = api_key

        # Suppress LiteLLM's own verbose logging in production;
        # structured logs are emitted at the application layer.
        litellm.suppress_debug_info = True

    # ── ModelGateway protocol implementation ─────────────────────

    async def generate(
        self,
        request: ModelRequest,
        *,
        tools: Sequence[ToolDefinition] = (),
    ) -> ModelResponse:
        """Generate content or tool calls via LiteLLM for the requested profile."""
        profile = self._profile_registry.require(request.model_profile)
        return await self._invoke_litellm(profile, request, tools)

    async def stream(
        self,
        request: ModelRequest,
        *,
        tools: Sequence[ToolDefinition] = (),
    ) -> AsyncIterator[ModelStreamChunk]:
        """Stream incremental deltas and tool calls via LiteLLM."""
        profile = self._profile_registry.require(request.model_profile)
        call_kwargs, timeout_sec = self._build_call_kwargs(
            profile, request, tools, stream=True
        )
        provider = self._extract_provider(profile.model)
        start_time = time.monotonic()

        accumulated_tools: dict[int, dict[str, Any]] = {}
        latest_usage: ModelUsage | None = None
        last_raw_finish: str | None = None
        provider_request_id: str | None = None

        try:
            async with asyncio.timeout(timeout_sec):
                raw_stream = await litellm.acompletion(**call_kwargs)
                async for raw_chunk in raw_stream:
                    req_id = getattr(raw_chunk, "id", None)
                    if req_id:
                        provider_request_id = req_id

                    chunk_usage = self._extract_usage(raw_chunk)
                    if chunk_usage is not None:
                        latest_usage = chunk_usage

                    choices = getattr(raw_chunk, "choices", None) or []
                    choice = choices[0] if choices else None
                    if not choice:
                        continue

                    raw_finish = getattr(choice, "finish_reason", None)
                    if raw_finish:
                        last_raw_finish = raw_finish

                    delta = getattr(choice, "delta", None)
                    if not delta:
                        continue

                    self._accumulate_delta_tools(accumulated_tools, delta)
                    delta_text = getattr(delta, "content", None)
                    if isinstance(delta_text, str) and delta_text:
                        yield ModelStreamChunk(
                            provider=provider,
                            model=profile.model,
                            model_profile=profile.profile_name,
                            gateway_backend=GATEWAY_BACKEND,
                            content_delta=delta_text,
                            provider_request_id=provider_request_id,
                        )
        except TimeoutError as exc:
            raise ModelTimeoutError(
                f"LiteLLM stream timed out after {timeout_sec}s for model '{profile.model}'"
            ) from exc
        except ModelGatewayError:
            raise
        except Exception as exc:
            raise self._map_error(exc, profile.model) from exc

        tool_calls = self._finalize_accumulated_tools(accumulated_tools)
        finish_reason = self._resolve_finish_reason(last_raw_finish, tool_calls)
        latency_ms = int((time.monotonic() - start_time) * 1000)

        yield ModelStreamChunk(
            provider=provider,
            model=profile.model,
            model_profile=profile.profile_name,
            gateway_backend=GATEWAY_BACKEND,
            content_delta="",
            tool_calls=tool_calls,
            finish_reason=finish_reason,
            usage=latest_usage or ModelUsage(),
            latency_ms=latency_ms,
            provider_request_id=provider_request_id,
        )

    # ── Provider call ────────────────────────────────────────────

    def _build_call_kwargs(
        self,
        profile: ModelProfile,
        request: ModelRequest,
        tools: Sequence[ToolDefinition],
        *,
        stream: bool = False,
    ) -> tuple[dict[str, Any], int]:
        timeout_sec = request.timeout_override or profile.timeout_seconds

        call_kwargs: dict[str, Any] = {
            "model": profile.model,
            "messages": request.messages,
            "timeout": timeout_sec,
        }

        if self._api_key:
            call_kwargs["api_key"] = self._api_key

        litellm_tools = self._build_tools(tools)
        if litellm_tools:
            call_kwargs["tools"] = litellm_tools
            call_kwargs["tool_choice"] = "auto"

        if request.structured_response_schema:
            call_kwargs["response_format"] = {
                "type": "json_schema",
                "json_schema": {
                    "name": "structured_response",
                    "schema": request.structured_response_schema,
                },
            }

        if stream:
            call_kwargs["stream"] = True
            call_kwargs["stream_options"] = {"include_usage": True}

        return call_kwargs, timeout_sec

    async def _invoke_litellm(
        self,
        profile: ModelProfile,
        request: ModelRequest,
        tools: Sequence[ToolDefinition],
    ) -> ModelResponse:
        """Prepare payload, call LiteLLM SDK, and map the response."""
        call_kwargs, timeout_sec = self._build_call_kwargs(
            profile, request, tools, stream=False
        )

        start_time = time.monotonic()
        try:
            raw_response: LiteLLMModelResponse = await asyncio.wait_for(
                litellm.acompletion(**call_kwargs),
                timeout=timeout_sec,
            )
        except TimeoutError as exc:
            raise ModelTimeoutError(
                f"LiteLLM call timed out after {timeout_sec}s for model '{profile.model}'"
            ) from exc
        except Exception as exc:
            raise self._map_error(exc, profile.model) from exc

        latency_ms = int((time.monotonic() - start_time) * 1000)

        # Extract provider from model identifier (e.g. "openai/gpt-4o" → "openai")
        provider = self._extract_provider(profile.model)

        return self._normalize_response(
            raw=raw_response,
            model_identifier=profile.model,
            provider=provider,
            profile_name=profile.profile_name,
            latency_ms=latency_ms,
        )

    # ── Conversions ──────────────────────────────────────────────

    @staticmethod
    def _build_tools(
        tools: Sequence[ToolDefinition],
    ) -> list[dict[str, Any]] | None:
        """Convert internal ToolDefinition list to OpenAI-format tool dicts."""
        if not tools:
            return None

        result: list[dict[str, Any]] = []
        for t in tools:
            result.append(
                {
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.input_schema if t.input_schema else {},
                    },
                }
            )
        return result

    @staticmethod
    def _extract_provider(model_identifier: str) -> str:
        """Extract provider name from a LiteLLM model identifier.

        ``openai/gpt-4o``       → ``openai``
        ``anthropic/claude-sonnet-4-20250514`` → ``anthropic``
        ``ollama/llama3``       → ``ollama``
        ``gpt-4o``              → ``openai`` (LiteLLM default)
        """
        if "/" in model_identifier:
            return model_identifier.split("/", 1)[0]
        return "openai"  # LiteLLM default provider

    @staticmethod
    def _parse_tool_arguments(args_raw: Any) -> dict[str, Any]:
        if isinstance(args_raw, str):
            try:
                args = json.loads(args_raw)
                return args if isinstance(args, dict) else {"value": args}
            except (json.JSONDecodeError, TypeError):
                return {"raw": args_raw}
        if isinstance(args_raw, dict):
            return args_raw
        return {}

    @staticmethod
    def _resolve_finish_reason(
        raw_finish: str | None, tool_calls: list[ModelToolCall]
    ) -> FinishReason:
        if tool_calls:
            return FinishReason.TOOL_CALL
        if raw_finish == "length":
            return FinishReason.LENGTH
        return FinishReason.STOP

    @staticmethod
    def _extract_usage(raw: Any) -> ModelUsage | None:
        raw_usage = getattr(raw, "usage", None)
        if not raw_usage:
            return None
        return ModelUsage(
            input_tokens=getattr(raw_usage, "prompt_tokens", None),
            output_tokens=getattr(raw_usage, "completion_tokens", None),
            total_tokens=getattr(raw_usage, "total_tokens", None),
        )

    @staticmethod
    def _accumulate_delta_tools(
        accumulated: dict[int, dict[str, Any]],
        delta: Any,
    ) -> None:
        delta_tools = getattr(delta, "tool_calls", None)
        if not delta_tools:
            return
        for tc_delta in delta_tools:
            idx = getattr(tc_delta, "index", None)
            if idx is None:
                idx = len(accumulated)
            entry = accumulated.setdefault(
                idx, {"id": None, "name": "", "arguments_parts": [], "arguments_dict": None}
            )
            tc_id = getattr(tc_delta, "id", None)
            if tc_id:
                entry["id"] = tc_id
            fn = getattr(tc_delta, "function", None)
            if fn:
                fn_name = getattr(fn, "name", None)
                if fn_name:
                    entry["name"] += fn_name
                fn_args = getattr(fn, "arguments", None)
                if isinstance(fn_args, str) and fn_args:
                    entry["arguments_parts"].append(fn_args)
                elif isinstance(fn_args, dict):
                    entry["arguments_dict"] = fn_args

    @classmethod
    def _finalize_accumulated_tools(
        cls,
        accumulated: dict[int, dict[str, Any]],
    ) -> list[ModelToolCall]:
        tool_calls: list[ModelToolCall] = []
        for idx in sorted(accumulated):
            entry = accumulated[idx]
            name = entry["name"] or f"tool_{idx}"
            if entry["arguments_dict"] is not None:
                args = entry["arguments_dict"]
            else:
                raw_args = "".join(entry["arguments_parts"])
                args = cls._parse_tool_arguments(raw_args) if raw_args else {}
            tool_calls.append(
                ModelToolCall(
                    id=entry["id"] or f"call_{name}_{len(tool_calls)}",
                    name=name,
                    arguments=args,
                )
            )
        return tool_calls

    def _normalize_response(
        self,
        *,
        raw: LiteLLMModelResponse,
        model_identifier: str,
        provider: str,
        profile_name: str,
        latency_ms: int,
    ) -> ModelResponse:
        """Map LiteLLM raw response to normalised ModelResponse."""
        choice = raw.choices[0] if raw.choices else None
        message = choice.message if choice else None

        # 1. Tool calls
        tool_calls: list[ModelToolCall] = []
        if message and message.tool_calls:
            for tc in message.tool_calls:
                args = self._parse_tool_arguments(tc.function.arguments)
                tool_calls.append(
                    ModelToolCall(
                        id=tc.id or f"call_{tc.function.name}_{len(tool_calls)}",
                        name=tc.function.name,
                        arguments=args,
                    )
                )

        # 2. Finish reason
        raw_finish = choice.finish_reason if choice else None
        finish_reason = self._resolve_finish_reason(raw_finish, tool_calls)

        # 3. Usage
        usage = self._extract_usage(raw) or ModelUsage()

        # 4. Text content
        text_content: str | None = None
        if message and message.content:
            text_content = message.content

        # 5. Provider request ID
        provider_request_id: str | None = None
        if hasattr(raw, "id") and raw.id:
            provider_request_id = raw.id

        return ModelResponse(
            provider=provider,
            model=model_identifier,
            model_profile=profile_name,
            gateway_backend=GATEWAY_BACKEND,
            content=text_content,
            tool_calls=tool_calls,
            finish_reason=finish_reason,
            usage=usage,
            latency_ms=latency_ms,
            provider_request_id=provider_request_id,
        )

    # ── Error mapping ────────────────────────────────────────────

    @staticmethod
    def _map_error(exc: Exception, model_identifier: str) -> ModelGatewayError:
        """Map LiteLLM exceptions to ModelGatewayError hierarchy.

        LiteLLM normalises provider errors to OpenAI-compatible exception
        types, so the mapping is consistent across all providers.
        """
        msg = str(exc)

        # Rate limit / quota exceeded
        if isinstance(exc, litellm.RateLimitError):
            return ModelRateLimitError(f"Rate limit exceeded for model '{model_identifier}': {msg}")

        # Timeout
        if isinstance(exc, litellm.Timeout):
            return ModelTimeoutError(f"Request timed out for model '{model_identifier}': {msg}")

        # Service unavailable / server errors
        if isinstance(exc, litellm.ServiceUnavailableError):
            return ModelUnavailableError(
                f"Service unavailable for model '{model_identifier}': {msg}"
            )

        # API connection errors (transient)
        if isinstance(exc, litellm.APIConnectionError):
            return ModelUnavailableError(
                f"API connection error for model '{model_identifier}': {msg}"
            )

        # Authentication / permission — not retryable
        if isinstance(exc, (litellm.AuthenticationError, litellm.PermissionDeniedError)):
            return ModelGatewayError(
                f"Authentication/permission error for model '{model_identifier}': {msg}",
                retryable=False,
            )

        # Bad request — not retryable
        if isinstance(exc, litellm.BadRequestError):
            return ModelGatewayError(
                f"Bad request for model '{model_identifier}': {msg}",
                retryable=False,
            )

        # Not found — not retryable
        if isinstance(exc, litellm.NotFoundError):
            return ModelGatewayError(
                f"Model not found '{model_identifier}': {msg}",
                retryable=False,
            )

        # Generic API error — inspect status code
        if isinstance(exc, litellm.APIError):
            status = getattr(exc, "status_code", None)
            if status and status >= 500:
                return ModelUnavailableError(
                    f"API server error ({status}) for model '{model_identifier}': {msg}"
                )
            return ModelGatewayError(
                f"API error for model '{model_identifier}': {msg}",
                retryable=False,
            )

        # Unknown / general
        return ModelGatewayError(
            f"LiteLLM error for model '{model_identifier}': {msg}",
            retryable=False,
        )
