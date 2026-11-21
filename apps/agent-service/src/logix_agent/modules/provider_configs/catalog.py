"""Allow-listed tenant model providers backed by service environment keys.

The MVP deliberately keeps credentials at service scope. Tenant configuration
selects one provider/model, while the corresponding provider key is read from
``AgentSettings`` and never crosses the API boundary.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from logix_agent.config import AgentSettings


class ProviderCatalogError(ValueError):
    """Raised when a provider/model is outside the configured MVP catalog."""


@dataclass(frozen=True, slots=True)
class ProviderSpec:
    provider: str
    gateway_backend: str
    api_key_attribute: str | None
    environment_key: str | None
    base_url_attribute: str | None = None
    model_prefix: str | None = None
    development_only: bool = False


PROVIDER_SPECS: tuple[ProviderSpec, ...] = (
    ProviderSpec(
        provider="gemini",
        gateway_backend="gemini",
        api_key_attribute="gemini_api_key",
        environment_key="GEMINI_API_KEY",
        model_prefix="gemini-",
    ),
    ProviderSpec(
        provider="openai",
        gateway_backend="litellm_sdk",
        api_key_attribute="openai_api_key",
        environment_key="OPENAI_API_KEY",
        model_prefix="openai/",
    ),
    ProviderSpec(
        provider="anthropic",
        gateway_backend="litellm_sdk",
        api_key_attribute="anthropic_api_key",
        environment_key="ANTHROPIC_API_KEY",
        model_prefix="anthropic/",
    ),
    ProviderSpec(
        provider="azure",
        gateway_backend="litellm_sdk",
        api_key_attribute="azure_api_key",
        environment_key="AZURE_API_KEY",
        base_url_attribute="azure_api_base",
        model_prefix="azure/",
    ),
    ProviderSpec(
        provider="ollama",
        gateway_backend="litellm_sdk",
        api_key_attribute=None,
        environment_key=None,
        base_url_attribute="ollama_api_base",
        model_prefix="ollama/",
    ),
    ProviderSpec(
        provider="fake",
        gateway_backend="fake",
        api_key_attribute=None,
        environment_key=None,
        development_only=True,
    ),
)

_BY_PROVIDER = {spec.provider: spec for spec in PROVIDER_SPECS}


def get_provider_spec(provider: str) -> ProviderSpec:
    """Return the normalized provider definition or fail closed."""

    normalized = provider.strip().lower()
    try:
        return _BY_PROVIDER[normalized]
    except KeyError as exc:
        raise ProviderCatalogError(f"Unsupported model provider: '{normalized}'") from exc


def is_provider_configured(spec: ProviderSpec, settings: AgentSettings) -> bool:
    """Check availability without returning or logging any credential value."""

    if spec.development_only and settings.environment not in {"development", "test"}:
        return False
    if spec.api_key_attribute and not getattr(settings, spec.api_key_attribute, None):
        return False
    if spec.base_url_attribute and not getattr(settings, spec.base_url_attribute, None):
        return False
    return True


def configured_provider_specs(settings: AgentSettings) -> tuple[ProviderSpec, ...]:
    """Return only providers whose service-level prerequisites are present."""

    return tuple(spec for spec in PROVIDER_SPECS if is_provider_configured(spec, settings))


def require_configured_provider(provider: str, settings: AgentSettings) -> ProviderSpec:
    """Validate provider availability without exposing the configured key."""

    spec = get_provider_spec(provider)
    if not is_provider_configured(spec, settings):
        raise ProviderCatalogError(
            f"Provider '{spec.provider}' is not configured in agent-service environment"
        )
    return spec


def validate_model_for_provider(provider: str, model: str, settings: AgentSettings) -> ProviderSpec:
    """Validate provider availability and its normalized model identifier."""

    spec = require_configured_provider(provider, settings)
    normalized_model = model.strip()
    if not normalized_model:
        raise ProviderCatalogError("Model identifier is required")
    if spec.model_prefix and not normalized_model.startswith(spec.model_prefix):
        raise ProviderCatalogError(
            f"Model '{normalized_model}' does not match provider '{spec.provider}'"
        )
    return spec
