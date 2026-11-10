"""Unit tests for OpenTelemetry GenAI semantic conventions and lifecycle."""

from __future__ import annotations

import pytest
from langchain_core.messages import HumanMessage
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from logix_agent.config import AgentSettings
from logix_agent.modules.ai.adapters.fake_gateway import FakeModelGateway
from logix_agent.modules.ai.contracts import FinishReason, ModelResponse, ModelToolCall, ModelUsage
from logix_agent.modules.ai.errors import ModelUnavailableError
from logix_agent.modules.ai.langchain_adapter import ModelGatewayChatModel
from logix_agent.modules.telemetry import (
    GEN_AI_OPERATION_NAME,
    GEN_AI_REQUEST_MODEL,
    GEN_AI_RESPONSE_FINISH_REASONS,
    GEN_AI_SYSTEM,
    GEN_AI_USAGE_INPUT_TOKENS,
    GEN_AI_USAGE_OUTPUT_TOKENS,
    GEN_AI_USAGE_TOTAL_TOKENS,
    LOGIX_CORRELATION_ID,
    LOGIX_TENANT_ID,
    get_tracer,
    setup_telemetry,
    shutdown_telemetry,
)


@pytest.fixture
def in_memory_tracer():
    """Configure an in-memory span exporter for testing trace emission."""
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    orig_provider = trace._TRACER_PROVIDER
    trace._TRACER_PROVIDER = provider
    yield exporter
    trace._TRACER_PROVIDER = orig_provider
    exporter.clear()


def test_telemetry_disabled_safe_fallback():
    """When otel_enabled is False, setup_telemetry should not crash and tracer behaves as no-op."""
    settings = AgentSettings(otel_enabled=False)
    setup_telemetry(settings)

    tracer = get_tracer("test.tracer")
    with tracer.start_as_current_span("test.span") as span:
        span.set_attribute("key", "val")

    shutdown_telemetry()


@pytest.mark.asyncio
async def test_gen_ai_chat_span_attributes(in_memory_tracer: InMemorySpanExporter):
    """Verify that calling ModelGatewayChatModel generates a gen_ai.chat span with GenAI attributes."""
    canned_response = ModelResponse(
        provider="gemini",
        model="gemini-3.5-flash-lite",
        model_profile="planner-default",
        gateway_backend="gemini",
        content="Xin chào, tôi là LogiX Copilot.",
        tool_calls=[],
        finish_reason=FinishReason.STOP,
        usage=ModelUsage(input_tokens=520, output_tokens=35, total_tokens=555),
        latency_ms=120,
    )
    fake_gateway = FakeModelGateway(responses=[canned_response])

    model = ModelGatewayChatModel(gateway=fake_gateway, model_profile="planner-default")
    messages = [HumanMessage(content="Chào bạn")]

    result = await model.ainvoke(
        messages,
        tenant_id="tenant-123",
        correlation_id="corr-456",
        execution_id="exec-789",
    )
    assert result.content == "Xin chào, tôi là LogiX Copilot."

    spans = in_memory_tracer.get_finished_spans()
    gen_ai_spans = [s for s in spans if s.name == "gen_ai.chat"]
    assert len(gen_ai_spans) == 1

    span = gen_ai_spans[0]
    attrs = span.attributes
    assert attrs is not None
    assert attrs[GEN_AI_OPERATION_NAME] == "chat"
    assert attrs[GEN_AI_SYSTEM] == "gemini"
    assert attrs[GEN_AI_REQUEST_MODEL] == "gemini-3.5-flash-lite"
    assert attrs[GEN_AI_USAGE_INPUT_TOKENS] == 520
    assert attrs[GEN_AI_USAGE_OUTPUT_TOKENS] == 35
    assert attrs[GEN_AI_USAGE_TOTAL_TOKENS] == 555
    assert attrs[GEN_AI_RESPONSE_FINISH_REASONS] == ("stop",)
    assert attrs[LOGIX_TENANT_ID] == "tenant-123"
    assert attrs[LOGIX_CORRELATION_ID] == "corr-456"


@pytest.mark.asyncio
async def test_gen_ai_chat_span_records_exception(in_memory_tracer: InMemorySpanExporter):
    """Verify that model errors are recorded on the span with ERROR status code."""
    fake_gateway = FakeModelGateway(
        error=ModelUnavailableError("AI service temporarily down")
    )

    model = ModelGatewayChatModel(gateway=fake_gateway, model_profile="planner-default")
    messages = [HumanMessage(content="Kiểm tra")]

    with pytest.raises(ModelUnavailableError):
        await model.ainvoke(
            messages,
            tenant_id="tenant-err",
            correlation_id="corr-err",
        )

    spans = in_memory_tracer.get_finished_spans()
    gen_ai_spans = [s for s in spans if s.name == "gen_ai.chat"]
    assert len(gen_ai_spans) == 1

    span = gen_ai_spans[0]
    assert span.status.status_code == trace.StatusCode.ERROR
    assert "AI service temporarily down" in span.status.description


@pytest.mark.asyncio
async def test_agent_node_and_tool_execution_spans(in_memory_tracer: InMemorySpanExporter):
    """Verify that agent_node and execute_tool_node emit planner.agent_node and tool.{name} spans."""
    from pydantic import BaseModel

    from logix_agent.modules.auth import Actor
    from logix_agent.modules.planner.nodes import create_agent_node, create_execute_tool_node
    from logix_agent.modules.registry import RiskLevel, ToolContext, ToolRegistry, ToolSpec

    # 1. Setup registry with a test tool
    registry = ToolRegistry()

    class EchoIn(BaseModel):
        msg: str

    class EchoOut(BaseModel):
        reply: str

    async def echo_handler(ctx: ToolContext, params: EchoIn) -> EchoOut:
        return EchoOut(reply=f"Echo: {params.msg}")

    registry.register(
        ToolSpec(
            name="test_echo",
            description="Echoes message",
            input_model=EchoIn,
            output_model=EchoOut,
            required_permission=None,
            risk_level=RiskLevel.READ,
            handler=echo_handler,
            target_service="test",
        )
    )

    # 2. Setup fake model returning a tool call
    canned_response = ModelResponse(
        provider="gemini",
        model="gemini-3.5-flash-lite",
        model_profile="planner-default",
        gateway_backend="gemini",
        content="",
        tool_calls=[
            ModelToolCall(
                name="test_echo",
                arguments={"msg": "hello tracing"},
                id="call_echo_1",
            )
        ],
        finish_reason=FinishReason.TOOL_CALL,
        usage=ModelUsage(input_tokens=100, output_tokens=20, total_tokens=120),
        latency_ms=80,
    )
    fake_gateway = FakeModelGateway(responses=[canned_response])
    model = ModelGatewayChatModel(gateway=fake_gateway, model_profile="planner-default")

    agent_node = create_agent_node(model, registry)
    execute_tool_node = create_execute_tool_node(registry)

    actor = Actor(
        user_id="user-42",
        tenant_id="tenant-99",
        role="DISPATCHER",
        permissions=frozenset(),
        access_token="fake-token",
    )
    config = {
        "configurable": {
            "actor": actor,
            "correlation_id": "corr-echo-test",
        }
    }

    # Run agent node
    state = {"messages": [HumanMessage(content="run echo")]}
    agent_result = await agent_node(state, config)
    assert len(agent_result["messages"]) == 1

    # Run tool execution node
    state["messages"].extend(agent_result["messages"])
    tool_result = await execute_tool_node(state, config)
    assert len(tool_result["messages"]) == 1
    assert "Echo: hello tracing" in tool_result["messages"][0].content

    # Assert spans
    spans = in_memory_tracer.get_finished_spans()
    span_names = [s.name for s in spans]

    assert "gen_ai.chat" in span_names
    assert "planner.agent_node" in span_names
    assert "tool.test_echo" in span_names

    agent_span = next(s for s in spans if s.name == "planner.agent_node")
    assert agent_span.attributes["logix.tenant_id"] == "tenant-99"
    assert agent_span.attributes["logix.actor.user_id"] == "user-42"
    assert agent_span.attributes["logix.actor.role"] == "DISPATCHER"

    tool_span = next(s for s in spans if s.name == "tool.test_echo")
    assert tool_span.attributes["logix.tool.name"] == "test_echo"
    assert tool_span.attributes["logix.tenant_id"] == "tenant-99"
