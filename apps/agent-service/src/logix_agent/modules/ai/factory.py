"""Factory for instantiating ModelGateway based on application settings."""

from __future__ import annotations

import logging

from logix_agent.config import AgentSettings
from logix_agent.modules.ai.adapters.fake_gateway import FakeModelGateway
from logix_agent.modules.ai.adapters.gemini_gateway import GeminiModelGateway
from logix_agent.modules.ai.model_profiles import ConfigModelProfileRegistry
from logix_agent.modules.ai.policies import (
    CapabilityCheckingModelGateway,
    RetryingModelGateway,
)
from logix_agent.modules.ai.ports import ModelGateway, ModelProfileRegistry

logger = logging.getLogger(__name__)


def create_model_gateway(
    settings: AgentSettings,
    profile_registry: ModelProfileRegistry | None = None,
) -> ModelGateway:
    """Create a ModelGateway instance matching configured backend.

    Supported backends:
    - ``gemini``: Production adapter calling Google GenAI SDK.
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
    else:
        raise ValueError(
            f"Unsupported llm_gateway_backend: '{backend}'. "
            f"Supported backends are: 'gemini', 'fake'."
        )

    return RetryingModelGateway(
        CapabilityCheckingModelGateway(adapter, profile_registry=registry),
        profile_registry=registry,
    )
