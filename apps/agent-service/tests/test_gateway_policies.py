"""Unit tests for provider-agnostic ModelGateway policy decorators.

These run against ``FakeModelGateway`` to prove the policy holds for *any*
adapter, not just Gemini.
"""

from collections.abc import AsyncIterator

import pytest

from logix_agent.config import AgentSettings
from logix_agent.modules.ai.adapters.fake_gateway import FakeModelGateway
from logix_agent.modules.ai.contracts import (
    FinishReason,
    ModelCapability,
    ModelProfile,
    ModelRequest,
    ModelResponse,
    ModelStreamChunk,
    ModelUsage,
    ToolDefinition,
)
from logix_agent.modules.ai.errors import (
    FallbackExhaustedError,
    ModelCapabilityError,
    ModelGatewayError,
    ModelRateLimitError,
    ModelResponseValidationError,
)
from logix_agent.modules.ai.model_profiles import ConfigModelProfileRegistry
from logix_agent.modules.ai.policies import (
    CapabilityCheckingModelGateway,
    RetryingModelGateway,
)


class ScriptedGateway:
    """Raises a scripted sequence of outcomes, recording served profiles."""

    def __init__(
        self,
        outcomes: list[ModelGatewayError | str | tuple[list[str], ModelGatewayError]],
    ) -> None:
        self._outcomes = list(outcomes)
        self.served_profiles: list[str] = []

    async def generate(self, request: ModelRequest, *, tools=()) -> ModelResponse:
        self.served_profiles.append(request.model_profile)
        outcome = self._outcomes.pop(0)
        if isinstance(outcome, ModelGatewayError):
            raise outcome
        assert isinstance(outcome, str)
        return FakeModelGateway.simple_text_response(outcome, model_profile=request.model_profile)

    async def stream(
        self, request: ModelRequest, *, tools=()
    ) -> AsyncIterator[ModelStreamChunk]:
        self.served_profiles.append(request.model_profile)
        outcome = self._outcomes.pop(0)
        if isinstance(outcome, ModelGatewayError):
            raise outcome
        if isinstance(outcome, tuple):
            deltas, error = outcome
            for delta in deltas:
                yield ModelStreamChunk(
                    provider="fake",
                    model="fake-model",
                    model_profile=request.model_profile,
                    gateway_backend="fake",
                    content_delta=delta,
                )
            raise error
        for delta in FakeModelGateway._split_text_deltas(outcome, None):
            yield ModelStreamChunk(
                provider="fake",
                model="fake-model",
                model_profile=request.model_profile,
                gateway_backend="fake",
                content_delta=delta,
            )
        yield ModelStreamChunk(
            provider="fake",
            model="fake-model",
            model_profile=request.model_profile,
            gateway_backend="fake",
            content_delta="",
            finish_reason=FinishReason.STOP,
            usage=ModelUsage(input_tokens=10, output_tokens=5, total_tokens=15),
        )


async def _no_sleep(_seconds: float) -> None:
    return None


def _request(profile: str = "planner-default", **overrides) -> ModelRequest:
    return ModelRequest(
        model_profile=profile,
        tenant_id="TENANT-01",
        correlation_id="01J-CORR",
        messages=[{"role": "user", "content": "Hi"}],
        **overrides,
    )


@pytest.fixture
def registry() -> ConfigModelProfileRegistry:
    return ConfigModelProfileRegistry(
        AgentSettings(
            planner_default_model="model-a",
            planner_fallback_model="model-b",
            llm_fallback_enabled=True,
            llm_max_attempts=2,
        )
    )


# ── Capability checking ──────────────────────────────────────────


@pytest.mark.asyncio
async def test_capability_check_rejects_tools_on_incapable_profile(registry):
    registry.register(
        ModelProfile(
            profile_name="no-tools-profile",
            model="model-a",
            required_capabilities=[],
        )
    )
    gateway = CapabilityCheckingModelGateway(
        FakeModelGateway.with_text("never reached"), profile_registry=registry
    )

    with pytest.raises(ModelCapabilityError) as exc_info:
        await gateway.generate(
            _request("no-tools-profile"),
            tools=[ToolDefinition(name="test", description="desc")],
        )
    assert "lacks TOOL_CALLING" in str(exc_info.value)


@pytest.mark.asyncio
async def test_capability_check_rejects_structured_output_on_incapable_profile(registry):
    registry.register(
        ModelProfile(
            profile_name="text-only",
            model="model-a",
            required_capabilities=[ModelCapability.TOOL_CALLING],
        )
    )
    gateway = CapabilityCheckingModelGateway(
        FakeModelGateway.with_text("never reached"), profile_registry=registry
    )

    with pytest.raises(ModelCapabilityError):
        await gateway.generate(_request("text-only", structured_response_schema={"type": "object"}))


@pytest.mark.asyncio
async def test_capability_check_passes_through_when_declared(registry):
    gateway = CapabilityCheckingModelGateway(
        FakeModelGateway.with_text("ok"), profile_registry=registry
    )

    response = await gateway.generate(
        _request(), tools=[ToolDefinition(name="test", description="desc")]
    )
    assert response.content == "ok"


# ── Retry ────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_retry_recovers_within_profile_and_records_attempt(registry):
    inner = ScriptedGateway([ModelRateLimitError(), "recovered"])
    gateway = RetryingModelGateway(inner, profile_registry=registry, sleep=_no_sleep)

    response = await gateway.generate(_request())

    assert response.content == "recovered"
    assert response.attempt == 2
    assert inner.served_profiles == ["planner-default", "planner-default"]


@pytest.mark.asyncio
async def test_retry_does_not_retry_non_transient_errors(registry):
    inner = ScriptedGateway([ModelResponseValidationError(), "unused"])
    gateway = RetryingModelGateway(inner, profile_registry=registry, sleep=_no_sleep)

    with pytest.raises(ModelResponseValidationError):
        await gateway.generate(_request())

    assert inner.served_profiles == ["planner-default"]


# ── Fallback ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_fallback_switches_profile_after_bounded_retry(registry):
    inner = ScriptedGateway([ModelRateLimitError(), ModelRateLimitError(), "fallback answer"])
    gateway = RetryingModelGateway(inner, profile_registry=registry, sleep=_no_sleep)

    response = await gateway.generate(_request())

    assert response.content == "fallback answer"
    assert response.model_profile == "planner-fallback"
    assert inner.served_profiles == [
        "planner-default",
        "planner-default",
        "planner-fallback",
    ]


@pytest.mark.asyncio
async def test_fallback_exhausted_reports_full_chain(registry):
    inner = ScriptedGateway([ModelRateLimitError() for _ in range(3)])
    gateway = RetryingModelGateway(inner, profile_registry=registry, sleep=_no_sleep)

    with pytest.raises(FallbackExhaustedError) as exc_info:
        await gateway.generate(_request())
    assert exc_info.value.chain == ["planner-default", "planner-fallback"]


@pytest.mark.asyncio
async def test_no_fallback_when_profile_declares_none(registry):
    registry.register(
        ModelProfile(
            profile_name="solo",
            model="model-a",
            required_capabilities=[],
            max_attempts=1,
        )
    )
    inner = ScriptedGateway([ModelRateLimitError()])
    gateway = RetryingModelGateway(inner, profile_registry=registry, sleep=_no_sleep)

    with pytest.raises(ModelRateLimitError):
        await gateway.generate(_request("solo"))

    assert inner.served_profiles == ["solo"]


# ── Streaming policy ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_stream_capability_check_rejects_tools_on_incapable_profile(registry):
    registry.register(
        ModelProfile(
            profile_name="no-tools-profile",
            model="model-a",
            required_capabilities=[],
        )
    )
    gateway = CapabilityCheckingModelGateway(
        FakeModelGateway.with_text("never reached"), profile_registry=registry
    )

    with pytest.raises(ModelCapabilityError):
        async for _ in gateway.stream(
            _request("no-tools-profile"),
            tools=[ToolDefinition(name="test", description="desc")],
        ):
            pass


@pytest.mark.asyncio
async def test_stream_retry_recovers_before_first_chunk(registry):
    inner = ScriptedGateway([ModelRateLimitError(), "recovered stream"])
    gateway = RetryingModelGateway(inner, profile_registry=registry, sleep=_no_sleep)

    chunks = [chunk async for chunk in gateway.stream(_request())]

    assert "".join(c.content_delta for c in chunks) == "recovered stream"
    assert chunks[-1].attempt == 2
    assert inner.served_profiles == ["planner-default", "planner-default"]


@pytest.mark.asyncio
async def test_stream_fallback_switches_profile_after_pre_stream_retries(registry):
    inner = ScriptedGateway([ModelRateLimitError(), ModelRateLimitError(), "fallback stream"])
    gateway = RetryingModelGateway(inner, profile_registry=registry, sleep=_no_sleep)

    chunks = [chunk async for chunk in gateway.stream(_request())]

    assert "".join(c.content_delta for c in chunks) == "fallback stream"
    assert chunks[-1].model_profile == "planner-fallback"
    assert inner.served_profiles == [
        "planner-default",
        "planner-default",
        "planner-fallback",
    ]


@pytest.mark.asyncio
async def test_stream_does_not_retry_or_fallback_after_first_chunk_emitted(registry):
    inner = ScriptedGateway([(["partial "], ModelRateLimitError()), "should not run"])
    gateway = RetryingModelGateway(inner, profile_registry=registry, sleep=_no_sleep)

    received: list[str] = []
    with pytest.raises(ModelRateLimitError):
        async for chunk in gateway.stream(_request()):
            if chunk.content_delta:
                received.append(chunk.content_delta)

    assert received == ["partial "]
    assert inner.served_profiles == ["planner-default"]


@pytest.mark.asyncio
async def test_stream_fallback_exhausted_reports_full_chain(registry):
    inner = ScriptedGateway([ModelRateLimitError() for _ in range(3)])
    gateway = RetryingModelGateway(inner, profile_registry=registry, sleep=_no_sleep)

    with pytest.raises(FallbackExhaustedError) as exc_info:
        async for _ in gateway.stream(_request()):
            pass
    assert exc_info.value.chain == ["planner-default", "planner-fallback"]
