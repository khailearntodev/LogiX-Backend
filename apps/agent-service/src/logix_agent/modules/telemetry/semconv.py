"""OpenTelemetry GenAI Semantic Conventions and LogiX specific attribute names."""

from __future__ import annotations

# Standard OTel GenAI Semantic Conventions
GEN_AI_OPERATION_NAME = "gen_ai.operation.name"
GEN_AI_SYSTEM = "gen_ai.system"
GEN_AI_REQUEST_MODEL = "gen_ai.request.model"
GEN_AI_USAGE_INPUT_TOKENS = "gen_ai.usage.input_tokens"
GEN_AI_USAGE_OUTPUT_TOKENS = "gen_ai.usage.output_tokens"
GEN_AI_USAGE_TOTAL_TOKENS = "gen_ai.usage.total_tokens"
GEN_AI_RESPONSE_FINISH_REASONS = "gen_ai.response.finish_reasons"

# LogiX Domain Attributes
LOGIX_TENANT_ID = "logix.tenant_id"
LOGIX_CORRELATION_ID = "logix.correlation_id"
LOGIX_EXECUTION_ID = "logix.execution_id"
LOGIX_TOOL_NAME = "logix.tool.name"
LOGIX_ACTOR_USER_ID = "logix.actor.user_id"
LOGIX_ACTOR_ROLE = "logix.actor.role"

