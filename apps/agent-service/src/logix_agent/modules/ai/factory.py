"""Factory for instantiating ModelGateway based on application settings."""

from __future__ import annotations

import logging

from logix_agent.config import AgentSettings
from logix_agent.modules.ai.adapters.fake_gateway import FakeModelGateway
from logix_agent.modules.ai.adapters.gemini_gateway import GeminiModelGateway
from logix_agent.modules.ai.adapters.litellm_gateway import LiteLLMModelGateway
from logix_agent.modules.ai.model_profiles import ConfigModelProfileRegistry
from logix_agent.modules.ai.policies import (
    CapabilityCheckingModelGateway,
    RetryingModelGateway,
)
from logix_agent.modules.ai.ports import ModelGateway, ModelProfileRegistry

logger = logging.getLogger(__name__)


def _resolve_litellm_api_key(settings: AgentSettings) -> str | None:
    """Pick the most relevant API key for the configured default model.

    LiteLLM also reads provider-specific env vars (``OPENAI_API_KEY``,
    ``ANTHROPIC_API_KEY``, etc.) automatically, so returning ``None``
    here is acceptable when env vars are set directly.
    """
    model = (settings.planner_default_model or "").lower()
    if model.startswith("anthropic/") or model.startswith("claude"):
        return settings.anthropic_api_key
    if model.startswith("azure/"):
        return settings.azure_api_key
    if model.startswith("ollama"):
        return None  # Ollama doesn't need an API key
    # Default to OpenAI key (also used for models without prefix)
    return settings.openai_api_key


def create_model_gateway(
    settings: AgentSettings,
    profile_registry: ModelProfileRegistry | None = None,
) -> ModelGateway:
    """Create a ModelGateway instance matching configured backend.

    Supported backends:
    - ``gemini``: Production adapter calling Google GenAI SDK.
    - ``litellm_sdk``: Multi-provider adapter via LiteLLM Python SDK.
    - ``fake``: In-memory deterministic fake for offline testing and CI.

    Every backend is wrapped in the same capability and retry/fallback policy so
    provider swaps cannot silently change those guarantees.
    """
    backend = (settings.llm_gateway_backend or "gemini").lower()
    registry = profile_registry or ConfigModelProfileRegistry(settings)

    adapter: ModelGateway
    if backend == "fake":
        logger.info("Using FakeModelGateway (offline test mode)")
        adapter = FakeModelGateway()
    elif backend == "gemini":
        logger.info(
            "Using GeminiModelGateway with default model '%s'",
            settings.planner_default_model,
        )
        adapter = GeminiModelGateway(
            profile_registry=registry,
            api_key=settings.gemini_api_key,
        )
    elif backend == "litellm_sdk":
        logger.info(
            "Using LiteLLMModelGateway with default model '%s'",
            settings.planner_default_model,
        )
        adapter = LiteLLMModelGateway(
            profile_registry=registry,
            api_key=_resolve_litellm_api_key(settings),
        )
    else:
        raise ValueError(
            f"Unsupported llm_gateway_backend: '{backend}'. "
            f"Supported backends are: 'gemini', 'litellm_sdk', 'fake'."
        )

    return RetryingModelGateway(
        CapabilityCheckingModelGateway(adapter, profile_registry=registry),
        profile_registry=registry,
    )

