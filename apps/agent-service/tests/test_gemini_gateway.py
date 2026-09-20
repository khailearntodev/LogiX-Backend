"""Unit tests for GeminiModelGateway (pure provider adapter).

Retry, fallback and capability policy are covered in ``test_gateway_policies``.
"""

from unittest.mock import AsyncMock, MagicMock
import pytest
from google.genai import errors as genai_errors
from google.genai import types

from logix_agent.config import AgentSettings
from logix_agent.modules.ai.adapters.gemini_gateway import GeminiModelGateway
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


@pytest.fixture
def mock_genai_client():
    client = MagicMock()
    client.aio.models.generate_content = AsyncMock()
    return client


@pytest.fixture
def profile_registry():
    settings = AgentSettings(
        planner_default_model="gemini-2.5-flash",
        planner_fallback_model="gemini-1.5-flash",
        llm_fallback_enabled=True,
    )
    return ConfigModelProfileRegistry(settings)


@pytest.mark.asyncio
async def test_gemini_gateway_success_text(mock_genai_client, profile_registry):
    mock_response = MagicMock(spec=types.GenerateContentResponse)
    mock_response.text = "Here is the sales order plan."
    mock_response.function_calls = None
    mock_response.usage_metadata = MagicMock(
        prompt_token_count=100,
        candidates_token_count=25,
        total_token_count=125,
    )
    mock_genai_client.aio.models.generate_content.return_value = mock_response

    gateway = GeminiModelGateway(profile_registry=profile_registry, client=mock_genai_client)

    response = await gateway.generate(_request())

    assert response.provider == "gemini"
    assert response.model == "gemini-2.5-flash"
    assert response.model_profile == "planner-default"
    assert response.gateway_backend == "gemini_sdk"
    assert response.content == "Here is the sales order plan."
    assert response.finish_reason == FinishReason.STOP
    assert response.usage.input_tokens == 100
    assert response.usage.output_tokens == 25
    assert response.usage.total_tokens == 125
    assert response.tool_calls == []
    assert response.latency_ms is not None


@pytest.mark.asyncio
async def test_gemini_gateway_tool_calls(mock_genai_client, profile_registry):
    fc = types.FunctionCall(name="cancel_order", args={"order_id": "ORD-001"})
    mock_response = MagicMock(spec=types.GenerateContentResponse)
    mock_response.text = None
    mock_response.function_calls = [fc]
    mock_response.usage_metadata = None
    mock_genai_client.aio.models.generate_content.return_value = mock_response

    gateway = GeminiModelGateway(profile_registry=profile_registry, client=mock_genai_client)

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


@pytest.mark.asyncio
async def test_gemini_gateway_resolves_fallback_profile_model(
    mock_genai_client, profile_registry
):
    mock_response = MagicMock(spec=types.GenerateContentResponse)
    mock_response.text = "Fallback answer"
    mock_response.function_calls = None
    mock_response.usage_metadata = None
    mock_genai_client.aio.models.generate_content.return_value = mock_response

    gateway = GeminiModelGateway(profile_registry=profile_registry, client=mock_genai_client)

    response = await gateway.generate(_request("planner-fallback"))

    assert response.model == "gemini-1.5-flash"
    assert response.model_profile == "planner-fallback"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("code", "expected_error", "expected_retryable"),
    [
        (429, ModelRateLimitError, True),
        (504, ModelTimeoutError, True),
        (503, ModelUnavailableError, True),
        (400, ModelGatewayError, False),
    ],
)
async def test_gemini_gateway_maps_api_errors(
    mock_genai_client,
    profile_registry,
    code,
    expected_error,
    expected_retryable,
):
    mock_genai_client.aio.models.generate_content.side_effect = genai_errors.APIError(
        code=code, response_json={"message": "boom"}
    )
    gateway = GeminiModelGateway(profile_registry=profile_registry, client=mock_genai_client)

    with pytest.raises(expected_error) as exc_info:
        await gateway.generate(_request())
    assert exc_info.value.retryable is expected_retryable


@pytest.mark.asyncio
async def test_gemini_gateway_does_not_retry_or_fall_back(
    mock_genai_client, profile_registry
):
    mock_genai_client.aio.models.generate_content.side_effect = genai_errors.APIError(
        code=503, response_json={"message": "Service unavailable"}
    )
    gateway = GeminiModelGateway(profile_registry=profile_registry, client=mock_genai_client)

    with pytest.raises(ModelUnavailableError):
        await gateway.generate(_request())

    assert mock_genai_client.aio.models.generate_content.call_count == 1
