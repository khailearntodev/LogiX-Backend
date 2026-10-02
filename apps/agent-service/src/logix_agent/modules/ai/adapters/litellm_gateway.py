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
from typing import Any, Sequence

import litellm
from litellm import ModelResponse as LiteLLMModelResponse

from logix_agent.modules.ai.contracts import (
    FinishReason,
    ModelProfile,
    ModelRequest,
    ModelResponse,
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

    # ── Provider call ────────────────────────────────────────────

    async def _invoke_litellm(
        self,
        profile: ModelProfile,
        request: ModelRequest,
        tools: Sequence[ToolDefinition],
    ) -> ModelResponse:
        """Prepare payload, call LiteLLM SDK, and map the response."""
        timeout_sec = request.timeout_override or profile.timeout_seconds

        # Build the call kwargs
        call_kwargs: dict[str, Any] = {
            "model": profile.model,
            "messages": request.messages,
            "timeout": timeout_sec,
        }

        # API key — use per-request override or adapter default
        if self._api_key:
            call_kwargs["api_key"] = self._api_key

        # Tools
        litellm_tools = self._build_tools(tools)
        if litellm_tools:
            call_kwargs["tools"] = litellm_tools
            call_kwargs["tool_choice"] = "auto"

        # Structured output
        if request.structured_response_schema:
            call_kwargs["response_format"] = {
                "type": "json_schema",
                "json_schema": {
                    "name": "structured_response",
                    "schema": request.structured_response_schema,
                },
            }

        start_time = time.monotonic()
        try:
            raw_response: LiteLLMModelResponse = await asyncio.wait_for(
                litellm.acompletion(**call_kwargs),
                timeout=timeout_sec,
            )
        except asyncio.TimeoutError as exc:
            raise ModelTimeoutError(
                f"LiteLLM call timed out after {timeout_sec}s "
                f"for model '{profile.model}'"
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
                args_raw = tc.function.arguments
                if isinstance(args_raw, str):
                    try:
                        args = json.loads(args_raw)
                    except (json.JSONDecodeError, TypeError):
                        args = {"raw": args_raw}
                elif isinstance(args_raw, dict):
                    args = args_raw
                else:
                    args = {}

                tool_calls.append(
                    ModelToolCall(
                        id=tc.id or f"call_{tc.function.name}_{len(tool_calls)}",
                        name=tc.function.name,
                        arguments=args,
                    )
                )

        # 2. Finish reason
        raw_finish = choice.finish_reason if choice else None
        if tool_calls:
            finish_reason = FinishReason.TOOL_CALL
        elif raw_finish == "length":
            finish_reason = FinishReason.LENGTH
        else:
            finish_reason = FinishReason.STOP

        # 3. Usage
        usage = ModelUsage()
        if hasattr(raw, "usage") and raw.usage:
            usage = ModelUsage(
                input_tokens=getattr(raw.usage, "prompt_tokens", None),
                output_tokens=getattr(raw.usage, "completion_tokens", None),
                total_tokens=getattr(raw.usage, "total_tokens", None),
            )

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
            return ModelRateLimitError(
                f"Rate limit exceeded for model '{model_identifier}': {msg}"
            )

        # Timeout
        if isinstance(exc, litellm.Timeout):
            return ModelTimeoutError(
                f"Request timed out for model '{model_identifier}': {msg}"
            )

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
