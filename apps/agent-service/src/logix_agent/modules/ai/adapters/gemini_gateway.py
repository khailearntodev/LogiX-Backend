"""Google Gemini adapter for the ModelGateway port.

This adapter implements the ``ModelGateway`` protocol using the official
Google GenAI SDK (``google-genai``).  It is a *pure* provider adapter:

* Text generation and structured output
* Function / tool calling
* Token usage tracking
* Profile lookup via ``ModelProfileRegistry``
* Mapping Google GenAI exceptions to LogiX ``ModelGatewayError`` hierarchy

Capability validation, bounded retry and fallback chaining are provider-agnostic
and live in ``logix_agent.modules.ai.policies``.

Design reference: ``ai-services-technical-design.md`` §8.5, §20.
"""

from __future__ import annotations

import asyncio
import time
import uuid
from typing import Any, Sequence

from google import genai
from google.genai import errors as genai_errors
from google.genai import types

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

GATEWAY_BACKEND = "gemini_sdk"


class GeminiModelGateway:
    """Concrete ModelGateway that delegates to Google Gemini.

    Parameters
    ----------
    profile_registry:
        Registry for resolving logical profile names (e.g. ``planner-default``)
        to model configurations.
    client:
        Optional pre-configured ``genai.Client``. If not provided, one is created
        using ``api_key`` or ambient environment credentials.
    api_key:
        Optional Gemini API key.
    """

    def __init__(
        self,
        *,
        profile_registry: ModelProfileRegistry,
        client: genai.Client | None = None,
        api_key: str | None = None,
    ) -> None:
        self._profile_registry = profile_registry
        self._client = client
        self._api_key = api_key

    def _get_client(self) -> genai.Client:
        """Return the Gemini Client, initializing lazily if needed."""
        if self._client is None:
            import os

            key = self._api_key or os.environ.get("GEMINI_API_KEY")
            if not key:
                raise ModelGatewayError(
                    "Gemini API key is not configured. "
                    "Set GEMINI_API_KEY environment variable or settings.gemini_api_key.",
                    retryable=False,
                )
            self._client = genai.Client(api_key=key)
        return self._client

    # ── ModelGateway protocol implementation ─────────────────────

    async def generate(
        self,
        request: ModelRequest,
        *,
        tools: Sequence[ToolDefinition] = (),
    ) -> ModelResponse:
        """Generate content or tool calls via Gemini for the requested profile."""
        profile = self._profile_registry.require(request.model_profile)
        return await self._invoke_gemini(profile, request, tools)

    # ── Provider call ────────────────────────────────────────────

    async def _invoke_gemini(
        self,
        profile: ModelProfile,
        request: ModelRequest,
        tools: Sequence[ToolDefinition],
    ) -> ModelResponse:
        """Prepare payload, call Google GenAI SDK, and map the response."""
        # Clean model name (strip any 'google/' or 'gemini/' prefix)
        model_name = profile.model
        for prefix in ("google/", "gemini/"):
            if model_name.startswith(prefix):
                model_name = model_name[len(prefix) :]

        timeout_sec = request.timeout_override or profile.timeout_seconds

        # Build contents and system instruction
        contents, system_instruction = self._build_contents(request.messages)

        # Build tools
        gemini_tools = self._build_tools(tools)

        # Build config
        config_kwargs: dict[str, Any] = {}
        if system_instruction:
            config_kwargs["system_instruction"] = system_instruction
        if gemini_tools:
            config_kwargs["tools"] = gemini_tools
        if request.structured_response_schema:
            config_kwargs["response_schema"] = request.structured_response_schema
            config_kwargs["response_mime_type"] = "application/json"

        config = types.GenerateContentConfig(**config_kwargs) if config_kwargs else None

        start_time = time.monotonic()
        try:
            client = self._get_client()
            call_coro = client.aio.models.generate_content(
                model=model_name,
                contents=contents,
                config=config,
            )
            raw_response = await asyncio.wait_for(call_coro, timeout=timeout_sec)
        except asyncio.TimeoutError as exc:
            raise ModelTimeoutError(
                f"Gemini call timed out after {timeout_sec}s for model '{model_name}'"
            ) from exc
        except Exception as exc:
            raise self._map_error(exc, model_name) from exc

        latency_ms = int((time.monotonic() - start_time) * 1000)
        return self._normalize_response(
            raw=raw_response,
            model_name=model_name,
            profile_name=profile.profile_name,
            latency_ms=latency_ms,
        )

    # ── Conversions ──────────────────────────────────────────────

    def _build_contents(
        self, messages: list[dict[str, Any]]
    ) -> tuple[list[types.Content], str | None]:
        """Convert standard message dicts to Gemini Content objects."""
        system_parts: list[str] = []
        contents: list[types.Content] = []

        for msg in messages:
            role = msg.get("role", "user")
            content_str = msg.get("content") or ""

            if role == "system":
                system_parts.append(content_str)
            elif role in ("assistant", "model"):
                parts: list[types.Part] = []
                if content_str:
                    parts.append(types.Part.from_text(text=content_str))
                # Handle assistant tool calls if present in message history
                for tc in msg.get("tool_calls") or []:
                    fn_name = tc.get("function", {}).get("name") or tc.get("name")
                    fn_args = tc.get("function", {}).get("arguments") or tc.get("arguments") or {}
                    parts.append(types.Part.from_function_call(name=fn_name, args=fn_args))
                if parts:
                    contents.append(types.Content(role="model", parts=parts))
            elif role in ("tool", "function"):
                # Tool response message
                fn_name = msg.get("name") or "tool_result"
                tool_content = msg.get("content")
                response_dict = (
                    {"result": tool_content}
                    if not isinstance(tool_content, dict)
                    else tool_content
                )
                contents.append(
                    types.Content(
                        role="user",
                        parts=[
                            types.Part.from_function_response(
                                name=fn_name,
                                response=response_dict,
                            )
                        ],
                    )
                )
            else:
                # User message
                contents.append(
                    types.Content(
                        role="user",
                        parts=[types.Part.from_text(text=content_str)],
                    )
                )

        system_instruction = "\n\n".join(system_parts) if system_parts else None
        return contents, system_instruction

    def _build_tools(
        self, tools: Sequence[ToolDefinition]
    ) -> list[types.Tool] | None:
        """Convert ToolDefinition list to Gemini types.Tool."""
        if not tools:
            return None

        declarations: list[types.FunctionDeclaration] = []
        for t in tools:
            declarations.append(
                types.FunctionDeclaration(
                    name=t.name,
                    description=t.description,
                    parameters=t.input_schema if t.input_schema else None,
                )
            )

        return [types.Tool(function_declarations=declarations)]

    def _normalize_response(
        self,
        *,
        raw: types.GenerateContentResponse,
        model_name: str,
        profile_name: str,
        latency_ms: int,
    ) -> ModelResponse:
        """Map Gemini raw response to normalized ModelResponse."""
        # 1. Tool calls
        tool_calls: list[ModelToolCall] = []
        if raw.function_calls:
            for idx, fc in enumerate(raw.function_calls):
                call_id = getattr(fc, "id", None) or f"call_{fc.name}_{idx}_{uuid.uuid4().hex[:6]}"
                args = dict(fc.args) if fc.args else {}
                tool_calls.append(
                    ModelToolCall(
                        id=call_id,
                        name=fc.name,
                        arguments=args,
                    )
                )

        # 2. Finish reason
        if tool_calls:
            finish_reason = FinishReason.TOOL_CALL
        else:
            finish_reason = FinishReason.STOP

        # 3. Usage
        usage = ModelUsage()
        if hasattr(raw, "usage_metadata") and raw.usage_metadata:
            usage = ModelUsage(
                input_tokens=getattr(raw.usage_metadata, "prompt_token_count", None),
                output_tokens=getattr(raw.usage_metadata, "candidates_token_count", None),
                total_tokens=getattr(raw.usage_metadata, "total_token_count", None),
            )

        # 4. Text content
        text_content: str | None = None
        try:
            text_content = raw.text
        except Exception:
            # When tool calls are generated, raw.text can raise if no text part
            pass

        return ModelResponse(
            provider="gemini",
            model=model_name,
            model_profile=profile_name,
            gateway_backend=GATEWAY_BACKEND,
            content=text_content,
            tool_calls=tool_calls,
            finish_reason=finish_reason,
            usage=usage,
            latency_ms=latency_ms,
        )

    # ── Error mapping ────────────────────────────────────────────

    def _map_error(self, exc: Exception, model_name: str) -> ModelGatewayError:
        """Map Gemini SDK / HTTP exceptions to ModelGatewayError hierarchy."""
        msg = str(exc)

        # Check GenAI APIError
        if isinstance(exc, genai_errors.APIError):
            code = getattr(exc, "code", None)
            if code == 429 or "RESOURCE_EXHAUSTED" in msg:
                return ModelRateLimitError(
                    f"Gemini rate limit exceeded for model '{model_name}': {msg}"
                )
            if code in (408, 504) or "DEADLINE_EXCEEDED" in msg:
                return ModelTimeoutError(
                    f"Gemini timeout for model '{model_name}': {msg}"
                )
            if isinstance(exc, genai_errors.ServerError) or (code and code >= 500):
                return ModelUnavailableError(
                    f"Gemini unavailable ({code}) for model '{model_name}': {msg}"
                )
            return ModelGatewayError(
                f"Gemini API error ({code}) for model '{model_name}': {msg}",
                retryable=False,
            )

        # Unknown / general
        return ModelGatewayError(
            f"Gemini error for model '{model_name}': {msg}",
            retryable=False,
        )
