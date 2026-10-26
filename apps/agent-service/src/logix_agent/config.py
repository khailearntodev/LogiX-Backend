from __future__ import annotations

import os
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

_SERVICE_DIR = Path(__file__).resolve().parent.parent.parent
_ENV_FILE = _SERVICE_DIR / ".env"


class AgentSettings(BaseSettings):
    service_name: str = "agent-service"
    port: int = 8001
    environment: str = "development"
    database_url: str | None = None
    log_level: str = "INFO"

    # ── Auth ─────────────────────────────────────────────────────
    # Must equal identity-service JWT_SECRET; requests are rejected while unset.
    jwt_secret: str | None = None

    # ── Downstream services (tool calls) ─────────────────────────
    identity_service_url: str = "http://localhost:3001"
    order_service_url: str = "http://localhost:3002"
    master_data_service_url: str = "http://localhost:3003"
    inventory_service_url: str = "http://localhost:3004"
    fulfillment_service_url: str = "http://localhost:3005"
    transport_service_url: str = "http://localhost:3006"
    route_optimizer_service_url: str = "http://localhost:8003"
    forecast_service_url: str = "http://localhost:8002"
    tool_http_timeout_seconds: float = 10.0
    tool_http_max_attempts: int = 2

    # ── Agent built on LangChain's create_agent (modules/agent) ──
    # "provider:model" string; the Gemini key below is the only one wired so far.
    agent_model: str = "google_genai:gemini-3.5-flash-lite"

    # ── LLM Gateway ──────────────────────────────────────────────
    llm_gateway_backend: str = "gemini"  # "gemini" | "litellm_sdk" | "fake"
    gemini_api_key: str | None = None
    planner_default_model: str = "gemini-3.5-flash-lite"
    planner_fallback_model: str | None = None
    llm_timeout_seconds: int = 30
    llm_max_attempts: int = 2
    llm_fallback_enabled: bool = False

    # ── LiteLLM provider keys (used when backend = "litellm_sdk") ─
    openai_api_key: str | None = None
    anthropic_api_key: str | None = None
    azure_api_key: str | None = None
    azure_api_base: str | None = None
    azure_api_version: str | None = None
    ollama_api_base: str | None = None

    # ── Prompt policy ────────────────────────────────────────────
    prompt_policy_version: str = "v1"

    model_config = SettingsConfigDict(
        env_file=(_ENV_FILE, ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )


settings = AgentSettings()

if settings.gemini_api_key:
    os.environ.setdefault("GEMINI_API_KEY", settings.gemini_api_key)
    os.environ.setdefault("GOOGLE_API_KEY", settings.gemini_api_key)
