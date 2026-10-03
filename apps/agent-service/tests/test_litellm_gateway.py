"""Unit tests for LiteLLMModelGateway (pure provider adapter).

Tests mirror the Gemini adapter test structure to ensure contract parity.
Retry, fallback and capability policy are covered in ``test_gateway_policies``.
"""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from logix_agent.config import AgentSettings
from logix_agent.modules.ai.adapters.litellm_gateway import (
    GATEWAY_BACKEND,
    LiteLLMModelGateway,
)
from logix_agent.modules.ai.contracts import (
    FinishReason,
    ModelRequest,
    ToolDefinition,
)
from logix_agent.modules.ai.errors import (
    ModelGatewayError,
    ModelRateLimitError,
    ModelTimeoutError,
    ModelUnavailableError,
)
from logix_agent.modules.ai.model_profiles import ConfigModelProfileRegistry


def _request(profile: str = "planner-default", **overrides) -> ModelRequest:
    return ModelRequest(
        model_profile=profile,
        tenant_id="TENANT-01",
        correlation_id="01J-CORR",
        messages=[{"role": "user", "content": "Help me plan"}],
        **overrides,
    )


def _make_profile_registry(**kwargs):
    """Build a profile registry with LiteLLM-style model identifiers."""
    defaults = {
        "planner_default_model": "openai/gpt-4o-mini",
        "planner_fallback_model": "anthropic/claude-sonnet-4-20250514",
        "llm_fallback_enabled": True,
    }
    defaults.update(kwargs)
    return ConfigModelProfileRegistry(AgentSettings(**defaults))


def _mock_litellm_response(
    *,
    content: str | None = "Here is the plan.",
    tool_calls: list | None = None,
    prompt_tokens: int = 100,
    completion_tokens: int = 25,
    total_tokens: int = 125,
    finish_reason: str = "stop",
    response_id: str = "chatcmpl-test-123",
):
    """Build a mock LiteLLM ModelResponse matching the OpenAI format."""
    message = SimpleNamespace(
        content=content,
        tool_calls=tool_calls,
        role="assistant",
    )
    choice = SimpleNamespace(
        message=message,
        finish_reason=finish_reason,
        index=0,
    )
    usage = SimpleNamespace(
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        total_tokens=total_tokens,
    )
    return SimpleNamespace(
        choices=[choice],
        usage=usage,
        id=response_id,
        model="gpt-4o-mini",
    )


def _mock_tool_call(
    name: str = "get_order_status",
    arguments: dict | None = None,
    call_id: str = "call_abc123",
):
    """Build a mock tool call in OpenAI format."""
    args = arguments or {"order_id": "ORD-001"}
    return SimpleNamespace(
        id=call_id,
        type="function",
        function=SimpleNamespace(
            name=name,
            arguments=json.dumps(args),
        ),
    )


# ── Success scenarios ────────────────────────────────────────────


@pytest.mark.asyncio
async def test_litellm_gateway_success_text():
    """Text response is normalised to ModelResponse with correct fields."""
    registry = _make_profile_registry()
    mock_response = _mock_litellm_response()

    with patch("logix_agent.modules.ai.adapters.litellm_gateway.litellm") as mock_litellm:
        mock_litellm.acompletion = AsyncMock(return_value=mock_response)
        mock_litellm.suppress_debug_info = True
        # Also mock the exception classes so isinstance() checks work
        mock_litellm.RateLimitError = type("RateLimitError", (Exception,), {})
        mock_litellm.Timeout = type("Timeout", (Exception,), {})
        mock_litellm.ServiceUnavailableError = type("ServiceUnavailableError", (Exception,), {})

        gateway = LiteLLMModelGateway(profile_registry=registry)
        response = await gateway.generate(_request())

    assert response.provider == "openai"
    assert response.model == "openai/gpt-4o-mini"
    assert response.model_profile == "planner-default"
    assert response.gateway_backend == GATEWAY_BACKEND
    assert response.content == "Here is the plan."
    assert response.finish_reason == FinishReason.STOP
    assert response.usage.input_tokens == 100
    assert response.usage.output_tokens == 25
    assert response.usage.total_tokens == 125
    assert response.tool_calls == []
    assert response.latency_ms is not None
    assert response.provider_request_id == "chatcmpl-test-123"


@pytest.mark.asyncio
async def test_litellm_gateway_tool_calls():
    """Tool call response is normalised with correct tool_call fields."""
    registry = _make_profile_registry()
    tc = _mock_tool_call(
        name="cancel_order",
        arguments={"order_id": "ORD-001"},
        call_id="call_cancel_1",
    )
    mock_response = _mock_litellm_response(
        content=None,
        tool_calls=[tc],
        finish_reason="tool_calls",
    )

    with patch("logix_agent.modules.ai.adapters.litellm_gateway.litellm") as mock_litellm:
        mock_litellm.acompletion = AsyncMock(return_value=mock_response)
        mock_litellm.suppress_debug_info = True
        mock_litellm.RateLimitError = type("RateLimitError", (Exception,), {})
        mock_litellm.Timeout = type("Timeout", (Exception,), {})
        mock_litellm.ServiceUnavailableError = type("ServiceUnavailableError", (Exception,), {})

        gateway = LiteLLMModelGateway(profile_registry=registry)
        tool = ToolDefinition(
            name="cancel_order",
            description="Cancel order",
            input_schema={"type": "object", "properties": {"order_id": {"type": "string"}}},
        )
        response = await gateway.generate(_request(), tools=[tool])

    assert response.finish_reason == FinishReason.TOOL_CALL
    assert len(response.tool_calls) == 1
    assert response.tool_calls[0].name == "cancel_order"
    assert response.tool_calls[0].arguments == {"order_id": "ORD-001"}
    assert response.tool_calls[0].id == "call_cancel_1"


@pytest.mark.asyncio
async def test_litellm_gateway_multiple_tool_calls():
    """Multiple tool calls in a single response are all normalised."""
    registry = _make_profile_registry()
    tc1 = _mock_tool_call(name="get_order_status", arguments={"order_id": "ORD-001"}, call_id="call_1")
    tc2 = _mock_tool_call(name="get_inventory_availability", arguments={"sku_id": "SKU-01"}, call_id="call_2")
    mock_response = _mock_litellm_response(
        content=None,
        tool_calls=[tc1, tc2],
        finish_reason="tool_calls",
    )

    with patch("logix_agent.modules.ai.adapters.litellm_gateway.litellm") as mock_litellm:
        mock_litellm.acompletion = AsyncMock(return_value=mock_response)
        mock_litellm.suppress_debug_info = True
        mock_litellm.RateLimitError = type("RateLimitError", (Exception,), {})
        mock_litellm.Timeout = type("Timeout", (Exception,), {})
        mock_litellm.ServiceUnavailableError = type("ServiceUnavailableError", (Exception,), {})

        gateway = LiteLLMModelGateway(profile_registry=registry)
        response = await gateway.generate(_request())

    assert len(response.tool_calls) == 2
    assert response.tool_calls[0].name == "get_order_status"
    assert response.tool_calls[1].name == "get_inventory_availability"


@pytest.mark.asyncio
async def test_litellm_gateway_resolves_fallback_profile_model():
    """Fallback profile resolves to the correct model identifier."""
    registry = _make_profile_registry()
    mock_response = _mock_litellm_response(content="Fallback answer")

    with patch("logix_agent.modules.ai.adapters.litellm_gateway.litellm") as mock_litellm:
        mock_litellm.acompletion = AsyncMock(return_value=mock_response)
        mock_litellm.suppress_debug_info = True
        mock_litellm.RateLimitError = type("RateLimitError", (Exception,), {})
        mock_litellm.Timeout = type("Timeout", (Exception,), {})
        mock_litellm.ServiceUnavailableError = type("ServiceUnavailableError", (Exception,), {})

        gateway = LiteLLMModelGateway(profile_registry=registry)
        response = await gateway.generate(_request("planner-fallback"))

    assert response.model == "anthropic/claude-sonnet-4-20250514"
    assert response.model_profile == "planner-fallback"
    assert response.provider == "anthropic"


# ── Provider extraction ──────────────────────────────────────────


def test_extract_provider_with_prefix():
    assert LiteLLMModelGateway._extract_provider("openai/gpt-4o") == "openai"
    assert LiteLLMModelGateway._extract_provider("anthropic/claude-sonnet-4-20250514") == "anthropic"
    assert LiteLLMModelGateway._extract_provider("azure/gpt-4-deployment") == "azure"
    assert LiteLLMModelGateway._extract_provider("ollama/llama3") == "ollama"


def test_extract_provider_without_prefix_defaults_openai():
    assert LiteLLMModelGateway._extract_provider("gpt-4o") == "openai"
    assert LiteLLMModelGateway._extract_provider("gpt-4o-mini") == "openai"


# ── Tool building ────────────────────────────────────────────────


def test_build_tools_empty():
    assert LiteLLMModelGateway._build_tools(()) is None
    assert LiteLLMModelGateway._build_tools([]) is None


def test_build_tools_converts_to_openai_format():
    tool = ToolDefinition(
        name="get_order_status",
        description="Get order status",
        input_schema={"type": "object", "properties": {"order_id": {"type": "string"}}},
    )
    result = LiteLLMModelGateway._build_tools([tool])
    assert result is not None
    assert len(result) == 1
    assert result[0]["type"] == "function"
    assert result[0]["function"]["name"] == "get_order_status"
    assert result[0]["function"]["description"] == "Get order status"
    assert "order_id" in result[0]["function"]["parameters"]["properties"]


# ── Error mapping ────────────────────────────────────────────────


def test_map_error_rate_limit():
    """RateLimitError maps to retryable ModelRateLimitError."""
    import litellm as real_litellm
    exc = real_litellm.RateLimitError(
        message="Rate limit exceeded",
        llm_provider="openai",
        model="gpt-4o",
    )
    result = LiteLLMModelGateway._map_error(exc, "openai/gpt-4o")
    assert isinstance(result, ModelRateLimitError)
    assert result.retryable is True


def test_map_error_timeout():
    """Timeout maps to retryable ModelTimeoutError."""
    import litellm as real_litellm
    exc = real_litellm.Timeout(
        message="Request timed out",
        llm_provider="openai",
        model="gpt-4o",
    )
    result = LiteLLMModelGateway._map_error(exc, "openai/gpt-4o")
    assert isinstance(result, ModelTimeoutError)
    assert result.retryable is True


def test_map_error_service_unavailable():
    """ServiceUnavailableError maps to retryable ModelUnavailableError."""
    import litellm as real_litellm
    exc = real_litellm.ServiceUnavailableError(
        message="Service unavailable",
        llm_provider="openai",
        model="gpt-4o",
    )
    result = LiteLLMModelGateway._map_error(exc, "openai/gpt-4o")
    assert isinstance(result, ModelUnavailableError)
    assert result.retryable is True


def test_map_error_bad_request():
    """BadRequestError maps to non-retryable ModelGatewayError."""
    import litellm as real_litellm
    exc = real_litellm.BadRequestError(
        message="Invalid request",
        llm_provider="openai",
        model="gpt-4o",
    )
    result = LiteLLMModelGateway._map_error(exc, "openai/gpt-4o")
    assert isinstance(result, ModelGatewayError)
    assert result.retryable is False


def test_map_error_authentication():
    """AuthenticationError maps to non-retryable ModelGatewayError."""
    import litellm as real_litellm
    exc = real_litellm.AuthenticationError(
        message="Invalid API key",
        llm_provider="openai",
        model="gpt-4o",
    )
    result = LiteLLMModelGateway._map_error(exc, "openai/gpt-4o")
    assert isinstance(result, ModelGatewayError)
    assert result.retryable is False


def test_map_error_unknown():
    """Unknown exceptions map to non-retryable ModelGatewayError."""
    exc = RuntimeError("Something unexpected")
    result = LiteLLMModelGateway._map_error(exc, "openai/gpt-4o")
    assert isinstance(result, ModelGatewayError)
    assert result.retryable is False


# ── Timeout handling ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_litellm_gateway_timeout_raises_model_timeout_error():
    """asyncio.TimeoutError during the call is wrapped as ModelTimeoutError."""
    registry = _make_profile_registry()

    with patch("logix_agent.modules.ai.adapters.litellm_gateway.litellm") as mock_litellm:
        mock_litellm.acompletion = AsyncMock(side_effect=asyncio.TimeoutError())
        mock_litellm.suppress_debug_info = True
        mock_litellm.RateLimitError = type("RateLimitError", (Exception,), {})
        mock_litellm.Timeout = type("Timeout", (Exception,), {})
        mock_litellm.ServiceUnavailableError = type("ServiceUnavailableError", (Exception,), {})

        gateway = LiteLLMModelGateway(profile_registry=registry)

        with pytest.raises(ModelTimeoutError) as exc_info:
            await gateway.generate(_request())
        assert exc_info.value.retryable is True


# ── No internal retry ────────────────────────────────────────────


@pytest.mark.asyncio
async def test_litellm_gateway_does_not_retry():
    """Adapter does not retry — that responsibility belongs to the policy layer."""
    registry = _make_profile_registry()

    import litellm as real_litellm
    svc_err = real_litellm.ServiceUnavailableError(
        message="Service unavailable",
        llm_provider="openai",
        model="gpt-4o-mini",
    )

    with patch("logix_agent.modules.ai.adapters.litellm_gateway.litellm") as mock_litellm:
        mock_litellm.acompletion = AsyncMock(side_effect=svc_err)
        mock_litellm.suppress_debug_info = True
        # Re-assign exception classes for isinstance checks
        mock_litellm.RateLimitError = real_litellm.RateLimitError
        mock_litellm.Timeout = real_litellm.Timeout
        mock_litellm.ServiceUnavailableError = real_litellm.ServiceUnavailableError
        mock_litellm.APIConnectionError = real_litellm.APIConnectionError
        mock_litellm.AuthenticationError = real_litellm.AuthenticationError
        mock_litellm.PermissionDeniedError = real_litellm.PermissionDeniedError
        mock_litellm.BadRequestError = real_litellm.BadRequestError
        mock_litellm.NotFoundError = real_litellm.NotFoundError
        mock_litellm.APIError = real_litellm.APIError

        gateway = LiteLLMModelGateway(profile_registry=registry)

        with pytest.raises(ModelUnavailableError):
            await gateway.generate(_request())

        assert mock_litellm.acompletion.call_count == 1


# ── Factory integration ──────────────────────────────────────────


def test_factory_creates_litellm_gateway():
    """Factory correctly creates a LiteLLM gateway when backend is litellm_sdk."""
    from logix_agent.modules.ai.factory import create_model_gateway
    from logix_agent.modules.ai.policies import (
        CapabilityCheckingModelGateway,
        RetryingModelGateway,
    )

    settings = AgentSettings(
        llm_gateway_backend="litellm_sdk",
        planner_default_model="openai/gpt-4o-mini",
        openai_api_key="test-key",
    )
    gw = create_model_gateway(settings)

    # Unwrap policy decorators
    assert isinstance(gw, RetryingModelGateway)
    assert isinstance(gw.inner, CapabilityCheckingModelGateway)
    adapter = gw.inner.inner
    assert isinstance(adapter, LiteLLMModelGateway)


def test_factory_error_message_includes_litellm():
    """Factory error message lists litellm_sdk as supported backend."""
    settings = AgentSettings(llm_gateway_backend="nonexistent")
    with pytest.raises(ValueError) as exc_info:
        from logix_agent.modules.ai.factory import create_model_gateway
        create_model_gateway(settings)
    assert "litellm_sdk" in str(exc_info.value)


# ── Config settings ──────────────────────────────────────────────


def test_config_has_litellm_settings():
    """AgentSettings exposes LiteLLM-specific provider key fields."""
    settings = AgentSettings(
        openai_api_key="sk-openai-test",
        anthropic_api_key="sk-ant-test",
        azure_api_key="sk-azure-test",
        azure_api_base="https://my-deployment.openai.azure.com",
        azure_api_version="2025-01-01",
        ollama_api_base="http://localhost:11434",
    )
    assert settings.openai_api_key == "sk-openai-test"
    assert settings.anthropic_api_key == "sk-ant-test"
    assert settings.azure_api_key == "sk-azure-test"
    assert settings.azure_api_base == "https://my-deployment.openai.azure.com"
    assert settings.ollama_api_base == "http://localhost:11434"


def test_config_litellm_settings_default_none():
    """LiteLLM settings default to None when not explicitly set."""
    settings = AgentSettings()
    assert settings.openai_api_key is None
    assert settings.anthropic_api_key is None
    assert settings.azure_api_key is None
    assert settings.ollama_api_base is None


# ── API key resolution ───────────────────────────────────────────


def test_resolve_litellm_api_key_openai():
    from logix_agent.modules.ai.factory import _resolve_litellm_api_key
    settings = AgentSettings(
        planner_default_model="openai/gpt-4o",
        openai_api_key="sk-openai",
    )
    assert _resolve_litellm_api_key(settings) == "sk-openai"


def test_resolve_litellm_api_key_anthropic():
    from logix_agent.modules.ai.factory import _resolve_litellm_api_key
    settings = AgentSettings(
        planner_default_model="anthropic/claude-sonnet-4-20250514",
        anthropic_api_key="sk-ant",
    )
    assert _resolve_litellm_api_key(settings) == "sk-ant"


def test_resolve_litellm_api_key_azure():
    from logix_agent.modules.ai.factory import _resolve_litellm_api_key
    settings = AgentSettings(
        planner_default_model="azure/my-deployment",
        azure_api_key="sk-azure",
    )
    assert _resolve_litellm_api_key(settings) == "sk-azure"


def test_resolve_litellm_api_key_ollama_returns_none():
    from logix_agent.modules.ai.factory import _resolve_litellm_api_key
    settings = AgentSettings(planner_default_model="ollama/llama3")
    assert _resolve_litellm_api_key(settings) is None


def test_resolve_litellm_api_key_bare_model_uses_openai():
    """Models without provider prefix default to OpenAI key."""
    from logix_agent.modules.ai.factory import _resolve_litellm_api_key
    settings = AgentSettings(
        planner_default_model="gpt-4o-mini",
        openai_api_key="sk-openai",
    )
    assert _resolve_litellm_api_key(settings) == "sk-openai"
