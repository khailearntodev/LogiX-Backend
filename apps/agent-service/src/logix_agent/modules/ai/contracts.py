"""Pydantic v2 contracts for the AI runtime.

These schemas define the internal contract between graph/agent code and the
ModelGateway port.  They intentionally contain **zero** provider-SDK imports
— LiteLLM, OpenAI SDK, etc. live exclusively in the adapter layer.

Schemas follow the design in ``ai-services-technical-design.md`` §8.5.2.
"""

from __future__ import annotations

from decimal import Decimal
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


# ── Enums ────────────────────────────────────────────────────────


class FinishReason(str, Enum):
    """Why the model stopped generating."""

    STOP = "stop"
    TOOL_CALL = "tool_call"
    LENGTH = "length"
    ERROR = "error"


class ModelCapability(str, Enum):
    """Capabilities that a model profile may require."""

    TOOL_CALLING = "tool_calling"
    STRUCTURED_OUTPUT = "structured_output"
    STREAMING = "streaming"


# ── Tool definition ──────────────────────────────────────────────


class ToolDefinition(BaseModel):
    """Schema presented to the model for function/tool calling."""

    name: str = Field(..., max_length=100)
    description: str = Field(..., max_length=1000)
    input_schema: dict[str, Any] = Field(
        default_factory=dict,
        description="JSON Schema describing the tool's input parameters.",
    )
    output_schema: dict[str, Any] | None = Field(
        default=None,
        description="JSON Schema describing the tool's output (optional).",
    )


# ── Model profile ───────────────────────────────────────────────


class ModelProfile(BaseModel):
    """Configuration for a named model profile (e.g. ``planner-default``).

    Graph nodes reference profiles by *name*; the actual provider/model
    identifier is resolved at runtime from configuration.
    """

    profile_name: str = Field(..., max_length=100)
    model: str = Field(
        ...,
        max_length=200,
        description=(
            "LiteLLM-style model identifier, e.g. 'openai/gpt-4o-mini'. "
            "Read from environment — never hard-coded in graph."
        ),
    )
    required_capabilities: list[ModelCapability] = Field(default_factory=list)
    timeout_seconds: int = Field(default=30, ge=1, le=300)
    max_attempts: int = Field(default=2, ge=1, le=5)
    fallback_profile: str | None = Field(
        default=None,
        description="Profile name to fall back to on transient failure.",
    )


# ── Request / response ──────────────────────────────────────────


class ModelRequest(BaseModel):
    """Payload sent from graph node to ModelGateway.generate()."""

    model_profile: str = Field(
        ...,
        description="Logical profile name, e.g. 'planner-default'.",
    )
    tenant_id: str = Field(
        ...,
        min_length=1,
        max_length=100,
        description="Verified tenant owning this call. Never taken from model output.",
    )
    correlation_id: str = Field(
        ...,
        min_length=1,
        max_length=100,
        description="Trace key propagated across HTTP, job, worker and event hops.",
    )
    execution_id: str | None = Field(
        default=None,
        max_length=100,
        description="Owning AgentExecution, when the call originates from one.",
    )
    messages: list[dict[str, Any]] = Field(
        ...,
        min_length=1,
        description="Conversation messages (already sanitised).",
    )
    system_policy_version: str = Field(default="v1")
    prompt_template_version: str | None = Field(default=None)
    structured_response_schema: dict[str, Any] | None = Field(
        default=None,
        description="JSON Schema for structured output, if requested.",
    )
    timeout_override: int | None = Field(
        default=None,
        ge=1,
        le=300,
        description="Per-request timeout override (seconds).",
    )
    cost_budget: Decimal | None = Field(
        default=None,
        description="Optional per-request cost ceiling.",
    )


class ModelToolCall(BaseModel):
    """A single tool/function call returned by the model."""

    id: str = Field(..., description="Provider-assigned tool-call identifier.")
    name: str = Field(..., max_length=100)
    arguments: dict[str, Any] = Field(default_factory=dict)


class ModelUsage(BaseModel):
    """Token / cost usage metadata."""

    input_tokens: int | None = Field(default=None, ge=0)
    output_tokens: int | None = Field(default=None, ge=0)
    total_tokens: int | None = Field(default=None, ge=0)
    cost_amount: Decimal | None = Field(default=None)


class ModelResponse(BaseModel):
    """Normalised response returned by ModelGateway.generate()."""

    provider: str = Field(..., description="Resolved provider, e.g. 'openai'.")
    model: str = Field(..., description="Resolved model identifier.")
    model_profile: str = Field(
        ...,
        description="Logical profile the gateway actually served, after any fallback.",
    )
    gateway_backend: str = Field(
        ...,
        description="Adapter that served the call, e.g. 'gemini_sdk' or 'fake'.",
    )
    attempt: int = Field(
        default=1,
        ge=1,
        description="1-based attempt number within the serving profile.",
    )
    content: str | None = Field(
        default=None, description="Text content when finish_reason is STOP."
    )
    tool_calls: list[ModelToolCall] = Field(default_factory=list)
    finish_reason: FinishReason = Field(default=FinishReason.STOP)
    usage: ModelUsage = Field(default_factory=ModelUsage)
    latency_ms: int | None = Field(default=None, ge=0)
    provider_request_id: str | None = Field(
        default=None,
        description="Provider request ID (redacted of credentials).",
    )
    validation_errors: list[str] = Field(default_factory=list)
