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
import base64
import inspect
import json
import time
import uuid
from collections.abc import AsyncIterator, Sequence
from typing import Any

from google import genai
from google.genai import errors as genai_errors
from google.genai import types

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

GATEWAY_BACKEND = "gemini_sdk"


_ALLOWED_GEMINI_SCHEMA_FIELDS = frozenset(types.Schema.model_fields.keys())


def _clean_schema_for_gemini(schema: dict[str, Any]) -> dict[str, Any]:
    """Gemini FunctionDeclaration schema validator forbids $defs, $ref and extra fields."""
    defs = schema.get("$defs") or schema.get("definitions") or {}

    def _resolve(node: Any, is_schema: bool = True) -> Any:
        if isinstance(node, dict):
            if is_schema and "anyOf" in node and isinstance(node["anyOf"], list):
                non_null = [
                    opt
                    for opt in node["anyOf"]
                    if isinstance(opt, dict) and opt.get("type") != "null"
                ]
                if len(non_null) == 1:
                    merged = {**non_null[0], **{k: v for k, v in node.items() if k != "anyOf"}}
                    if len(non_null) < len(node["anyOf"]):
                        merged.setdefault("nullable", True)
                    node = merged

            if "$ref" in node and isinstance(node["$ref"], str):
                ref_name = node["$ref"].split("/")[-1]
                if ref_name in defs:
                    resolved = _resolve(defs[ref_name].copy(), is_schema=True)
                    extra = {k: _resolve(v, is_schema=is_schema) for k, v in node.items() if k != "$ref"}
                    return {**resolved, **extra}

            cleaned: dict[str, Any] = {}
            if is_schema:
                if "exclusiveMinimum" in node and "minimum" not in node:
                    val = node["exclusiveMinimum"]
                    cleaned["minimum"] = (val + 1) if (isinstance(val, int) and node.get("type") == "integer") else val
                if "exclusiveMaximum" in node and "maximum" not in node:
                    val = node["exclusiveMaximum"]
                    cleaned["maximum"] = (val - 1) if (isinstance(val, int) and node.get("type") == "integer") else val
                if "const" in node and "enum" not in node:
                    cleaned["enum"] = [node["const"]]
                if "examples" in node and "example" not in node and isinstance(node["examples"], list) and node["examples"]:
                    cleaned["example"] = node["examples"][0]

            for k, v in node.items():
                if k in ("$defs", "definitions", "title", "exclusiveMinimum", "exclusiveMaximum", "const", "examples"):
                    continue
                if is_schema and k not in _ALLOWED_GEMINI_SCHEMA_FIELDS:
                    continue

                if k == "properties" and isinstance(v, dict):
                    cleaned[k] = {prop_name: _resolve(prop_val, is_schema=True) for prop_name, prop_val in v.items()}
                elif k in ("items", "any_of") and is_schema:
                    cleaned[k] = _resolve(v, is_schema=True)
                else:
                    cleaned[k] = _resolve(v, is_schema=False)
            return cleaned

        if isinstance(node, list):
            return [_resolve(item, is_schema=is_schema) for item in node]
        return node

    return _resolve(schema, is_schema=True)


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

    async def stream(
        self,
        request: ModelRequest,
        *,
        tools: Sequence[ToolDefinition] = (),
    ) -> AsyncIterator[ModelStreamChunk]:
        """Stream incremental text deltas and tool calls via Gemini."""
        profile = self._profile_registry.require(request.model_profile)
        model_name, timeout_sec, contents, config = self._prepare_call(profile, request, tools)

        start_time = time.monotonic()
        collected_tool_calls: list[ModelToolCall] = []
        latest_usage: ModelUsage | None = None
        final_finish_reason = FinishReason.STOP

        try:
            client = self._get_client()
            async with asyncio.timeout(timeout_sec):
                stream_obj = client.aio.models.generate_content_stream(
                    model=model_name,
                    contents=contents,
                    config=config,
                )
                if inspect.isawaitable(stream_obj):
                    stream_obj = await stream_obj

                async for raw_chunk in stream_obj:
                    delta_text = self._extract_text(raw_chunk)
                    chunk_tools = self._extract_tool_calls(
                        raw_chunk, start_index=len(collected_tool_calls)
                    )
                    if chunk_tools:
                        collected_tool_calls.extend(chunk_tools)
                    chunk_usage = self._extract_usage(raw_chunk)
                    if chunk_usage is not None:
                        latest_usage = chunk_usage
                    raw_finish = self._extract_finish_reason(raw_chunk)
                    if raw_finish != FinishReason.STOP:
                        final_finish_reason = raw_finish

                    if delta_text:
                        yield ModelStreamChunk(
                            provider="gemini",
                            model=model_name,
                            model_profile=profile.profile_name,
                            gateway_backend=GATEWAY_BACKEND,
                            content_delta=delta_text,
                        )
        except TimeoutError as exc:
            raise ModelTimeoutError(
                f"Gemini stream timed out after {timeout_sec}s for model '{model_name}'"
            ) from exc
        except ModelGatewayError:
            raise
        except Exception as exc:
            raise self._map_error(exc, model_name) from exc

        latency_ms = int((time.monotonic() - start_time) * 1000)
        if collected_tool_calls:
            final_finish_reason = FinishReason.TOOL_CALL

        yield ModelStreamChunk(
            provider="gemini",
            model=model_name,
            model_profile=profile.profile_name,
            gateway_backend=GATEWAY_BACKEND,
            content_delta="",
            tool_calls=collected_tool_calls,
            finish_reason=final_finish_reason,
            usage=latest_usage or ModelUsage(),
            latency_ms=latency_ms,
        )

    # ── Provider call ────────────────────────────────────────────

    def _prepare_call(
        self,
        profile: ModelProfile,
        request: ModelRequest,
        tools: Sequence[ToolDefinition],
    ) -> tuple[str, int, list[types.Content], types.GenerateContentConfig | None]:
        """Normalise model name, contents, tools, and config before calling Gemini."""
        model_name = profile.model
        for prefix in ("google/", "gemini/"):
            model_name = model_name.removeprefix(prefix)

        timeout_sec = request.timeout_override or profile.timeout_seconds
        contents, system_instruction = self._build_contents(request.messages)
        gemini_tools = self._build_tools(tools)

        config_kwargs: dict[str, Any] = {}
        if system_instruction:
            config_kwargs["system_instruction"] = system_instruction
        if gemini_tools:
            config_kwargs["tools"] = gemini_tools
        if request.structured_response_schema:
            config_kwargs["response_schema"] = request.structured_response_schema
            config_kwargs["response_mime_type"] = "application/json"

        config = types.GenerateContentConfig(**config_kwargs) if config_kwargs else None
        return model_name, timeout_sec, contents, config

    async def _invoke_gemini(
        self,
        profile: ModelProfile,
        request: ModelRequest,
        tools: Sequence[ToolDefinition],
    ) -> ModelResponse:
        """Prepare payload, call Google GenAI SDK, and map the response."""
        model_name, timeout_sec, contents, config = self._prepare_call(profile, request, tools)

        start_time = time.monotonic()
        try:
            client = self._get_client()
            call_coro = client.aio.models.generate_content(
                model=model_name,
                contents=contents,
                config=config,
            )
            raw_response = await asyncio.wait_for(call_coro, timeout=timeout_sec)
        except TimeoutError as exc:
            raise ModelTimeoutError(
                f"Gemini call timed out after {timeout_sec}s for model '{model_name}'"
            ) from exc
        except ModelGatewayError:
            raise
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
                    sig_b64 = tc.get("thought_signature")
                    sig_bytes: bytes | None = None
                    if sig_b64:
                        try:
                            sig_bytes = base64.b64decode(sig_b64)
                        except Exception:
                            sig_bytes = None
                    if sig_bytes:
                        parts.append(
                            types.Part(
                                function_call=types.FunctionCall(name=fn_name, args=fn_args),
                                thought_signature=sig_bytes,
                            )
                        )
                    else:
                        parts.append(types.Part.from_function_call(name=fn_name, args=fn_args))
                if parts:
                    if contents and contents[-1].role == "model":
                        contents[-1].parts.extend(parts)
                    else:
                        contents.append(types.Content(role="model", parts=parts))
            elif role in ("tool", "function"):
                # Tool response message
                fn_name = msg.get("name") or "tool_result"
                tool_content = msg.get("content")
                if isinstance(tool_content, str):
                    try:
                        response_dict = json.loads(tool_content)
                    except Exception:
                        response_dict = {"result": tool_content}
                elif isinstance(tool_content, dict):
                    response_dict = tool_content
                else:
                    response_dict = {"result": tool_content}

                if not isinstance(response_dict, dict):
                    response_dict = {"result": response_dict}

                resp_part = types.Part.from_function_response(
                    name=fn_name,
                    response=response_dict,
                )
                if (
                    contents
                    and contents[-1].role == "user"
                    and contents[-1].parts
                    and getattr(contents[-1].parts[0], "function_response", None) is not None
                ):
                    contents[-1].parts.append(resp_part)
                else:
                    contents.append(
                        types.Content(
                            role="user",
                            parts=[resp_part],
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

        # Gemini requires contents to start on a plain user turn (not model or function_response)
        first_user = next(
            (
                i
                for i, c in enumerate(contents)
                if c.role == "user"
                and not any(
                    getattr(p, "function_response", None) is not None for p in (c.parts or ())
                )
            ),
            0,
        )
        if first_user > 0:
            contents = contents[first_user:]

        system_instruction = "\n\n".join(system_parts) if system_parts else None
        return contents, system_instruction

    def _build_tools(self, tools: Sequence[ToolDefinition]) -> list[types.Tool] | None:
        """Convert ToolDefinition list to Gemini types.Tool."""
        if not tools:
            return None

        declarations: list[types.FunctionDeclaration] = []
        for t in tools:
            param_schema = (
                _clean_schema_for_gemini(t.input_schema)
                if t.input_schema
                else None
            )
            declarations.append(
                types.FunctionDeclaration(
                    name=t.name,
                    description=t.description,
                    parameters=param_schema,
                )
            )

        return [types.Tool(function_declarations=declarations)]

    @staticmethod
    def _extract_tool_calls(
        raw: types.GenerateContentResponse,
        *,
        start_index: int = 0,
    ) -> list[ModelToolCall]:
        tool_calls: list[ModelToolCall] = []
        candidate = raw.candidates[0] if (hasattr(raw, "candidates") and raw.candidates) else None
        if candidate and getattr(candidate, "content", None) and getattr(candidate.content, "parts", None):
            fc_idx = start_index
            for part in candidate.content.parts:
                if getattr(part, "function_call", None):
                    fc = part.function_call
                    call_id = (
                        getattr(fc, "id", None)
                        or f"call_{fc.name}_{fc_idx}_{uuid.uuid4().hex[:6]}"
                    )
                    args = dict(fc.args) if fc.args else {}
                    sig = getattr(part, "thought_signature", None)
                    sig_b64: str | None = None
                    if sig:
                        sig_b64 = (
                            base64.b64encode(sig).decode("ascii")
                            if isinstance(sig, bytes)
                            else str(sig)
                        )
                    tool_calls.append(
                        ModelToolCall(
                            id=call_id,
                            name=fc.name,
                            arguments=args,
                            thought_signature=sig_b64,
                        )
                    )
                    fc_idx += 1
        elif getattr(raw, "function_calls", None):
            for offset, fc in enumerate(raw.function_calls):
                call_id = (
                    getattr(fc, "id", None)
                    or f"call_{fc.name}_{start_index + offset}_{uuid.uuid4().hex[:6]}"
                )
                args = dict(fc.args) if fc.args else {}
                tool_calls.append(
                    ModelToolCall(
                        id=call_id,
                        name=fc.name,
                        arguments=args,
                    )
                )
        return tool_calls

    @staticmethod
    def _extract_finish_reason(raw: types.GenerateContentResponse) -> FinishReason:
        candidate = raw.candidates[0] if (hasattr(raw, "candidates") and raw.candidates) else None
        raw_finish = getattr(candidate, "finish_reason", None) if candidate else None
        if raw_finish is not None and str(raw_finish).endswith("MAX_TOKENS"):
            return FinishReason.LENGTH
        return FinishReason.STOP

    @staticmethod
    def _extract_usage(raw: types.GenerateContentResponse) -> ModelUsage | None:
        if hasattr(raw, "usage_metadata") and raw.usage_metadata:
            return ModelUsage(
                input_tokens=getattr(raw.usage_metadata, "prompt_token_count", None),
                output_tokens=getattr(raw.usage_metadata, "candidates_token_count", None),
                total_tokens=getattr(raw.usage_metadata, "total_token_count", None),
            )
        return None

    @staticmethod
    def _extract_text(raw: types.GenerateContentResponse) -> str | None:
        candidate = raw.candidates[0] if (hasattr(raw, "candidates") and raw.candidates) else None
        content = getattr(candidate, "content", None) if candidate else None
        raw_parts = getattr(content, "parts", None) if content else None
        parts = list(raw_parts) if raw_parts else []
        if parts:
            text_parts = [
                part.text
                for part in parts
                if isinstance(getattr(part, "text", None), str)
                and not (isinstance(getattr(part, "thought", None), bool) and part.thought)
            ]
            return "".join(text_parts) if text_parts else None
        try:
            text_val = raw.text
        except (AttributeError, ValueError):
            return None
        return text_val if isinstance(text_val, str) else None

    def _normalize_response(
        self,
        *,
        raw: types.GenerateContentResponse,
        model_name: str,
        profile_name: str,
        latency_ms: int,
    ) -> ModelResponse:
        """Map Gemini raw response to normalized ModelResponse."""
        tool_calls = self._extract_tool_calls(raw)
        finish_reason = (
            FinishReason.TOOL_CALL if tool_calls else self._extract_finish_reason(raw)
        )
        usage = self._extract_usage(raw) or ModelUsage()
        text_content = self._extract_text(raw)

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
                return ModelTimeoutError(f"Gemini timeout for model '{model_name}': {msg}")
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
