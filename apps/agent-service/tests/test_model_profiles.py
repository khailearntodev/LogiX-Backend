"""Unit tests for ModelProfileRegistry and profile configurations."""

import pytest

from logix_agent.config import AgentSettings
from logix_agent.modules.ai.contracts import ModelCapability, ModelProfile
from logix_agent.modules.ai.errors import ProfileNotFoundError
from logix_agent.modules.ai.model_profiles import ConfigModelProfileRegistry


def test_registry_builds_default_profile():
    settings = AgentSettings(
        planner_default_model="gemini-2.5-flash",
        llm_timeout_seconds=25,
        llm_max_attempts=3,
        llm_fallback_enabled=False,
    )
    registry = ConfigModelProfileRegistry(settings)

    profile = registry.require("planner-default")
    assert profile.profile_name == "planner-default"
    assert profile.model == "gemini-2.5-flash"
    assert profile.timeout_seconds == 25
    assert profile.max_attempts == 3
    assert profile.fallback_profile is None
    assert ModelCapability.TOOL_CALLING in profile.required_capabilities


def test_registry_with_fallback_profile():
    settings = AgentSettings(
        planner_default_model="gemini-2.5-flash",
        planner_fallback_model="gemini-1.5-flash",
        llm_fallback_enabled=True,
    )
    registry = ConfigModelProfileRegistry(settings)

    default_profile = registry.require("planner-default")
    assert default_profile.fallback_profile == "planner-fallback"

    fallback_profile = registry.require("planner-fallback")
    assert fallback_profile.model == "gemini-1.5-flash"
    assert fallback_profile.fallback_profile is None
    assert fallback_profile.max_attempts == 1


def test_registry_require_non_existent_raises():
    registry = ConfigModelProfileRegistry(AgentSettings())
    with pytest.raises(ProfileNotFoundError) as exc_info:
        registry.require("non-existent-profile")
    assert "non-existent-profile" in str(exc_info.value)


def test_registry_manual_registration():
    registry = ConfigModelProfileRegistry(AgentSettings())
    custom = ModelProfile(
        profile_name="custom-expert",
        model="gemini-2.5-pro",
        required_capabilities=[ModelCapability.STRUCTURED_OUTPUT],
    )
    registry.register(custom)

    retrieved = registry.get("custom-expert")
    assert retrieved is not None
    assert retrieved.model == "gemini-2.5-pro"
    assert "custom-expert" in registry.profile_names
