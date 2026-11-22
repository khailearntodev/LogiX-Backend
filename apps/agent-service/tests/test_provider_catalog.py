import pytest

from logix_agent.config import AgentSettings
from logix_agent.modules.provider_configs.catalog import (
    ProviderCatalogError,
    configured_provider_specs,
    require_configured_provider,
    validate_model_for_provider,
)


def test_configured_provider_catalog_exposes_availability_without_secret_values():
    settings = AgentSettings(
        environment="test",
        gemini_api_key="gemini-secret",
        openai_api_key="openai-secret",
    )

    providers = configured_provider_specs(settings)

    assert {provider.provider for provider in providers} == {"gemini", "openai", "fake"}
    assert all(not hasattr(provider, "api_key") for provider in providers)
    assert all("secret" not in repr(provider) for provider in providers)


def test_provider_requires_service_level_key():
    settings = AgentSettings(environment="test")

    with pytest.raises(ProviderCatalogError, match="not configured"):
        require_configured_provider("openai", settings)


def test_provider_model_prefix_is_validated_before_runtime():
    settings = AgentSettings(environment="test", openai_api_key="test-key")

    validate_model_for_provider("openai", "openai/gpt-4o-mini", settings)

    with pytest.raises(ProviderCatalogError, match="does not match provider"):
        validate_model_for_provider("openai", "claude-sonnet", settings)


def test_fake_provider_is_unavailable_outside_development():
    settings = AgentSettings(environment="production")

    with pytest.raises(ProviderCatalogError, match="not configured"):
        require_configured_provider("fake", settings)
