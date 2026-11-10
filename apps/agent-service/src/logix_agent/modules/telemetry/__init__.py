"""Telemetry module for LogiX Agent Service."""

from __future__ import annotations

from logix_agent.modules.telemetry.semconv import (
    GEN_AI_OPERATION_NAME,
    GEN_AI_REQUEST_MODEL,
    GEN_AI_RESPONSE_FINISH_REASONS,
    GEN_AI_SYSTEM,
    GEN_AI_USAGE_INPUT_TOKENS,
    GEN_AI_USAGE_OUTPUT_TOKENS,
    GEN_AI_USAGE_TOTAL_TOKENS,
    LOGIX_ACTOR_ROLE,
    LOGIX_ACTOR_USER_ID,
    LOGIX_CORRELATION_ID,
    LOGIX_EXECUTION_ID,
    LOGIX_TENANT_ID,
    LOGIX_TOOL_NAME,
)
from logix_agent.modules.telemetry.setup import get_tracer, setup_telemetry, shutdown_telemetry

__all__ = [
    "GEN_AI_OPERATION_NAME",
    "GEN_AI_REQUEST_MODEL",
    "GEN_AI_RESPONSE_FINISH_REASONS",
    "GEN_AI_SYSTEM",
    "GEN_AI_USAGE_INPUT_TOKENS",
    "GEN_AI_USAGE_OUTPUT_TOKENS",
    "GEN_AI_USAGE_TOTAL_TOKENS",
    "LOGIX_ACTOR_ROLE",
    "LOGIX_ACTOR_USER_ID",
    "LOGIX_CORRELATION_ID",
    "LOGIX_EXECUTION_ID",
    "LOGIX_TENANT_ID",
    "LOGIX_TOOL_NAME",
    "get_tracer",
    "setup_telemetry",
    "shutdown_telemetry",
]

