"""Unit tests for FakeModelGateway."""

import pytest

from logix_agent.modules.ai.adapters.fake_gateway import FakeModelGateway
from logix_agent.modules.ai.contracts import (
    FinishReason,
    ModelRequest,
    ModelResponse,
    ToolDefinition,
)
from logix_agent.modules.ai.errors import ModelTimeoutError


def _request(profile: str = "planner-default") -> ModelRequest:
    return ModelRequest(
        model_profile=profile,
        tenant_id="TENANT-01",
        correlation_id="01J-CORR",
        messages=[{"role": "user", "content": "Hi"}],
    )


@pytest.mark.asyncio
async def test_fake_gateway_sequential_responses():
    r1 = ModelResponse(
        provider="fake",
        model="fake-1",
        model_profile="planner-default",
        gateway_backend="fake",
        content="First",
    )
    r2 = ModelResponse(
        provider="fake",
        model="fake-2",
        model_profile="planner-default",
        gateway_backend="fake",
        content="Second",
    )
    gateway = FakeModelGateway(responses=[r1, r2])

    req = _request()
    tool = ToolDefinition(name="test_tool", description="Test")

    res1 = await gateway.generate(req, tools=[tool])
    assert res1.content == "First"
    assert gateway.call_count == 1
    assert len(gateway.requests) == 1
    assert gateway.tools_history[0] == [tool]

    res2 = await gateway.generate(req)
    assert res2.content == "Second"
    assert gateway.call_count == 2

    # Third call should raise IndexError because responses are exhausted
    with pytest.raises(IndexError):
        await gateway.generate(req)


@pytest.mark.asyncio
async def test_fake_gateway_stamps_served_profile_and_backend():
    gateway = FakeModelGateway.with_text("Static answer")

    res = await gateway.generate(_request("planner-fallback"))

    assert res.model_profile == "planner-fallback"
    assert res.gateway_backend == "fake"
    assert res.attempt == 1


@pytest.mark.asyncio
async def test_fake_gateway_with_text_factory():
    gateway = FakeModelGateway.with_text("Static answer")

    res = await gateway.generate(_request())
    assert res.content == "Static answer"
    assert res.finish_reason == FinishReason.STOP
    assert res.usage.total_tokens == 15


@pytest.mark.asyncio
async def test_fake_gateway_with_error():
    gateway = FakeModelGateway.with_error(ModelTimeoutError("Simulated timeout"))

    with pytest.raises(ModelTimeoutError) as exc_info:
        await gateway.generate(_request())
    assert exc_info.value.retryable is True
