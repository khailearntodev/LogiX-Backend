"""Unit tests for AI Pydantic contracts."""

from decimal import Decimal
import pytest
from pydantic import ValidationError

from logix_agent.modules.ai.contracts import (
    FinishReason,
    ModelCapability,
    ModelProfile,
    ModelRequest,
    ModelResponse,
    ModelToolCall,
    ModelUsage,
    ToolDefinition,
)


def test_tool_definition_valid():
    tool = ToolDefinition(
        name="cancel_order",
        description="Cancel a sales order",
        input_schema={
            "type": "object",
            "properties": {"order_id": {"type": "string"}},
            "required": ["order_id"],
        },
    )
    assert tool.name == "cancel_order"
    assert tool.description == "Cancel a sales order"
    assert "order_id" in tool.input_schema["properties"]


def test_tool_definition_validation_error():
    with pytest.raises(ValidationError):
        # name is required
        ToolDefinition.model_validate({"description": "missing name"})


def test_model_profile_creation():
    profile = ModelProfile(
        profile_name="planner-default",
        model="gemini-2.5-flash",
        required_capabilities=[ModelCapability.TOOL_CALLING],
        timeout_seconds=30,
        max_attempts=2,
    )
    assert profile.profile_name == "planner-default"
    assert profile.model == "gemini-2.5-flash"
    assert ModelCapability.TOOL_CALLING in profile.required_capabilities
    assert profile.fallback_profile is None


def test_model_request_validation():
    req = ModelRequest(
        model_profile="planner-default",
        tenant_id="TENANT-01",
        correlation_id="01J-CORR",
        execution_id="01J-EXEC",
        messages=[{"role": "user", "content": "Help me cancel order 123"}],
    )
    assert req.model_profile == "planner-default"
    assert req.tenant_id == "TENANT-01"
    assert req.correlation_id == "01J-CORR"
    assert req.execution_id == "01J-EXEC"
    assert len(req.messages) == 1
    assert req.system_policy_version == "v1"

    # Empty messages list should raise ValidationError (min_length=1)
    with pytest.raises(ValidationError):
        ModelRequest(
            model_profile="planner-default",
            tenant_id="TENANT-01",
            correlation_id="01J-CORR",
            messages=[],
        )


def test_model_request_requires_tenant_and_correlation():
    with pytest.raises(ValidationError):
        ModelRequest(
            model_profile="planner-default",
            messages=[{"role": "user", "content": "Hi"}],
        )

    with pytest.raises(ValidationError):
        ModelRequest(
            model_profile="planner-default",
            tenant_id="",
            correlation_id="01J-CORR",
            messages=[{"role": "user", "content": "Hi"}],
        )


def test_model_response_serialization():
    resp = ModelResponse(
        provider="gemini",
        model="gemini-2.5-flash",
        model_profile="planner-default",
        gateway_backend="gemini_sdk",
        content="Order cancelled successfully.",
        finish_reason=FinishReason.STOP,
        usage=ModelUsage(input_tokens=50, output_tokens=10, total_tokens=60, cost_amount=Decimal("0.0001")),
        latency_ms=320,
    )
    data = resp.model_dump()
    assert data["provider"] == "gemini"
    assert data["model"] == "gemini-2.5-flash"
    assert data["model_profile"] == "planner-default"
    assert data["gateway_backend"] == "gemini_sdk"
    assert data["attempt"] == 1
    assert data["content"] == "Order cancelled successfully."
    assert data["finish_reason"] == "stop"
    assert data["usage"]["total_tokens"] == 60


def test_model_response_with_tool_calls():
    tool_call = ModelToolCall(
        id="call_cancel_1",
        name="cancel_order",
        arguments={"order_id": "ORD-999"},
    )
    resp = ModelResponse(
        provider="gemini",
        model="gemini-2.5-flash",
        model_profile="planner-default",
        gateway_backend="gemini_sdk",
        tool_calls=[tool_call],
        finish_reason=FinishReason.TOOL_CALL,
    )
    assert len(resp.tool_calls) == 1
    assert resp.tool_calls[0].name == "cancel_order"
    assert resp.tool_calls[0].arguments["order_id"] == "ORD-999"
    assert resp.finish_reason == FinishReason.TOOL_CALL
