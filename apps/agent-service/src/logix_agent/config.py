from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class AgentSettings(BaseSettings):
    service_name: str = "agent-service"
    port: int = 8001
    environment: str = "development"
    database_url: str | None = None
    log_level: str = "INFO"

    # ── LLM Gateway ──────────────────────────────────────────────
    llm_gateway_backend: str = "gemini"  # "gemini" | "litellm_sdk" | "fake"
    gemini_api_key: str | None = None
    planner_default_model: str = "gemini-2.5-flash"
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
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


settings = AgentSettings()

