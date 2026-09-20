"""Deterministic fake ModelGateway for offline testing.

This adapter satisfies the ``ModelGateway`` protocol without making any
network calls.  It is used in:

* unit tests — assert that graph nodes handle responses/errors correctly;
* local development — run the full service without an LLM API key;
* CI — deterministic pipeline that never depends on external providers.

Usage::

    gateway = FakeModelGateway(responses=[
        FakeModelGateway.simple_text_response("Hello!"),
    ])

    result = await gateway.generate(request, tools=[])
    assert result.content == "Hello!"
    assert gateway.requests[0] == request  # recorded for assertion
"""

from __future__ import annotations

from collections.abc import Callable, Sequence

from logix_agent.modules.ai.contracts import (
    FinishReason,
    ModelRequest,
    ModelResponse,
    ModelUsage,
    ToolDefinition,
)
from logix_agent.modules.ai.errors import ModelGatewayError

GATEWAY_BACKEND = "fake"


class FakeModelGateway:
    """In-memory ModelGateway that returns pre-configured responses.

    Parameters
    ----------
    responses:
        A list of ``ModelResponse`` objects returned in order.  When the
        list is exhausted, subsequent calls raise ``IndexError``.
    response_factory:
        An optional callable ``(request, tools) -> ModelResponse`` for
        dynamic behaviour.  Takes precedence over ``responses`` if set.
    error:
        If set, every call raises this error (for failure-path testing).
    latency_ms:
        Simulated latency added to every response.
    """

    def __init__(
        self,
        *,
        responses: list[ModelResponse] | None = None,
        response_factory: Callable[
            [ModelRequest, Sequence[ToolDefinition]], ModelResponse
        ]
        | None = None,
        error: ModelGatewayError | None = None,
        latency_ms: int = 0,
    ) -> None:
        self._responses = list(responses) if responses else []
        self._response_factory = response_factory
        self._error = error
        self._latency_ms = latency_ms
        self._call_index = 0

        # ── Recorded state for assertions ────────────────────────
        self.requests: list[ModelRequest] = []
        self.tools_history: list[Sequence[ToolDefinition]] = []
        self.call_count: int = 0

    async def generate(
        self,
        request: ModelRequest,
        *,
        tools: Sequence[ToolDefinition] = (),
    ) -> ModelResponse:
        """Return a pre-configured response or raise a pre-configured error."""
        # Record
        self.requests.append(request)
        self.tools_history.append(tools)
        self.call_count += 1

        # Simulate error
        if self._error is not None:
            raise self._error

        # Build response
        if self._response_factory is not None:
            response = self._response_factory(request, tools)
        else:
            if self._call_index >= len(self._responses):
                raise IndexError(
                    f"FakeModelGateway exhausted: {self._call_index} calls "
                    f"but only {len(self._responses)} responses configured"
                )
            response = self._responses[self._call_index]
            self._call_index += 1

        # The gateway, not the caller, is authoritative on which profile it served.
        overrides: dict[str, object] = {
            "model_profile": request.model_profile,
            "gateway_backend": GATEWAY_BACKEND,
        }
        if self._latency_ms and response.latency_ms is None:
            overrides["latency_ms"] = self._latency_ms

        return response.model_copy(update=overrides)

    # ── Convenience factories ────────────────────────────────────

    @staticmethod
    def simple_text_response(
        text: str, *, model_profile: str = "planner-default"
    ) -> ModelResponse:
        """Create a minimal text response for quick test setup."""
        return ModelResponse(
            provider="fake",
            model="fake-model",
            model_profile=model_profile,
            gateway_backend=GATEWAY_BACKEND,
            content=text,
            finish_reason=FinishReason.STOP,
            usage=ModelUsage(input_tokens=10, output_tokens=5, total_tokens=15),
        )

    @classmethod
    def with_text(cls, text: str) -> FakeModelGateway:
        """Create a gateway that always returns the same text."""
        return cls(responses=[cls.simple_text_response(text)])

    @classmethod
    def with_error(cls, error: ModelGatewayError) -> FakeModelGateway:
        """Create a gateway that always raises the given error."""
        return cls(error=error)
