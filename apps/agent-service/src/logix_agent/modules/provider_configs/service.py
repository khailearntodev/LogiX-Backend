"""Application service for tenant model configuration.

This module owns the boundary between the HTTP contract, the provider catalog,
and persistence.  Provider credentials remain in ``AgentSettings`` and never
enter a request, database row, log message, or response.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable, Mapping, Sequence
from typing import Any, Protocol

from logix_agent.config import AgentSettings
from logix_agent.modules.ai.contracts import ModelRequest, ToolDefinition
from logix_agent.modules.ai.errors import ModelGatewayError
from logix_agent.modules.ai.factory import create_model_gateway
from logix_agent.modules.ai.ports import ModelGateway
from logix_agent.modules.auth import Actor
from logix_agent.modules.provider_configs.catalog import (
    PROVIDER_SPECS,
    ProviderCatalogError,
    ProviderSpec,
    get_provider_spec,
    is_provider_configured,
    validate_model_for_provider,
)
from logix_agent.modules.provider_configs.models import LlmProviderConfig
from logix_agent.modules.provider_configs.repository import (
    ProviderConfigVersionConflictError,
    SqlAlchemyProviderConfigRepository,
)

logger = logging.getLogger(__name__)

MODEL_CONFIG_READ = "agent:model-config:read"
MODEL_CONFIG_MANAGE = "agent:model-config:manage"

ALLOWED_PARAMETER_KEYS = frozenset({"timeout_seconds", "max_attempts"})
_TEST_TOOL = ToolDefinition(
    name="model_config_probe",
    description="A no-op probe used to verify provider tool-call compatibility.",
    input_schema={"type": "object", "properties": {}},
)


class ProviderConfigRepository(Protocol):
    async def get_active(self, tenant_id: str) -> LlmProviderConfig | None: ...

    async def save_active(
        self,
        *,
        tenant_id: str,
        provider: str,
        model: str,
        parameters: Mapping[str, Any] | None = None,
        expected_version: int | None = None,
    ) -> LlmProviderConfig: ...


class ModelConfigValidationError(ValueError):
    """The requested provider/model/parameters are outside the MVP catalog."""

    code = "MODEL_CONFIG_INVALID"


class ProviderNotConfiguredError(ModelConfigValidationError):
    code = "MODEL_CONFIG_PROVIDER_NOT_CONFIGURED"


class ModelConfigTestError(RuntimeError):
    """A provider test failed; the provider's raw exception is never exposed."""

    code = "MODEL_CONFIG_TEST_FAILED"


def normalize_parameters(parameters: Mapping[str, Any] | None) -> dict[str, Any]:
    """Validate and copy the small, non-secret MVP parameter set."""

    raw = dict(parameters or {})
    # The public API uses camelCase while persistence stays snake_case.
    if "timeoutSeconds" in raw:
        if "timeout_seconds" in raw:
            raise ModelConfigValidationError("timeout_seconds was supplied twice")
        raw["timeout_seconds"] = raw.pop("timeoutSeconds")
    if "maxAttempts" in raw:
        if "max_attempts" in raw:
            raise ModelConfigValidationError("max_attempts was supplied twice")
        raw["max_attempts"] = raw.pop("maxAttempts")
    unknown = sorted(set(raw) - ALLOWED_PARAMETER_KEYS)
    if unknown:
        raise ModelConfigValidationError(
            f"Unsupported model configuration parameters: {', '.join(unknown)}"
        )

    normalized: dict[str, Any] = {}
    if "timeout_seconds" in raw:
        timeout = raw["timeout_seconds"]
        if isinstance(timeout, bool) or not isinstance(timeout, int) or not 1 <= timeout <= 300:
            raise ModelConfigValidationError("timeout_seconds must be an integer from 1 to 300")
        normalized["timeout_seconds"] = timeout
    if "max_attempts" in raw:
        attempts = raw["max_attempts"]
        if isinstance(attempts, bool) or not isinstance(attempts, int) or not 1 <= attempts <= 5:
            raise ModelConfigValidationError("max_attempts must be an integer from 1 to 5")
        normalized["max_attempts"] = attempts
    return normalized


def _provider_specs(settings: AgentSettings) -> list[ProviderSpec]:
    """Return catalog metadata, including unavailable providers without secrets."""

    return list(PROVIDER_SPECS)


def _configured(spec: ProviderSpec, settings: AgentSettings) -> bool:
    return is_provider_configured(spec, settings)


def _require_selection(
    *, provider: str, model: str, parameters: Mapping[str, Any] | None, settings: AgentSettings
) -> tuple[ProviderSpec, dict[str, Any]]:
    normalized_parameters = normalize_parameters(parameters)
    try:
        spec = validate_model_for_provider(provider, model, settings)
    except ProviderCatalogError as exc:
        if "not configured" in str(exc):
            raise ProviderNotConfiguredError(str(exc)) from exc
        raise ModelConfigValidationError(str(exc)) from exc
    return spec, normalized_parameters


def has_model_config_permission(actor: Actor, permission: str) -> bool:
    """Mirror the identity-service permission guard for the agent boundary."""

    return (
        actor.role == "OWNER"
        or "*" in actor.permissions
        or permission in actor.permissions
    )


class ProviderConfigService:
    def __init__(
        self,
        repository: ProviderConfigRepository,
        *,
        settings: AgentSettings,
        gateway_factory: Callable[[AgentSettings], ModelGateway] = create_model_gateway,
    ) -> None:
        self._repository = repository
        self._settings = settings
        self._gateway_factory = gateway_factory

    @property
    def settings(self) -> AgentSettings:
        return self._settings

    def is_provider_configured(self, provider: str | None) -> bool:
        return provider_is_configured(provider, self._settings)

    async def get(self, tenant_id: str) -> LlmProviderConfig | None:
        return await self._repository.get_active(tenant_id)

    def catalog(self) -> Sequence[tuple[ProviderSpec, bool]]:
        return [(spec, _configured(spec, self._settings)) for spec in _provider_specs(self._settings)]

    async def save(
        self,
        *,
        tenant_id: str,
        provider: str,
        model: str,
        parameters: Mapping[str, Any] | None,
        expected_version: int | None,
    ) -> LlmProviderConfig:
        spec, normalized_parameters = _require_selection(
            provider=provider,
            model=model,
            parameters=parameters,
            settings=self._settings,
        )
        logger.info(
            "Saving tenant model configuration tenant=%s provider=%s model=%s expected_version=%s",
            tenant_id,
            spec.provider,
            model.strip(),
            expected_version,
        )
        try:
            return await self._repository.save_active(
                tenant_id=tenant_id,
                provider=spec.provider,
                model=model.strip(),
                parameters=normalized_parameters,
                expected_version=expected_version,
            )
        except ProviderConfigVersionConflictError:
            raise

    async def test(
        self,
        *,
        tenant_id: str,
        provider: str,
        model: str,
        parameters: Mapping[str, Any] | None,
    ) -> None:
        spec, normalized_parameters = _require_selection(
            provider=provider,
            model=model,
            parameters=parameters,
            settings=self._settings,
        )

        timeout_seconds = normalized_parameters.get(
            "timeout_seconds", self._settings.llm_timeout_seconds
        )
        max_attempts = normalized_parameters.get("max_attempts", 1)
        test_settings = self._settings.model_copy(
            update={
                "llm_gateway_backend": spec.gateway_backend,
                "planner_default_model": model.strip(),
                "llm_timeout_seconds": timeout_seconds,
                "llm_max_attempts": max_attempts,
                "llm_fallback_enabled": False,
            }
        )
        try:
            gateway = self._gateway_factory(test_settings)
            request = ModelRequest(
                model_profile="planner-default",
                tenant_id=tenant_id,
                correlation_id="model-config-test",
                messages=[
                    {
                        "role": "user",
                        "content": "Reply with OK to confirm this model connection.",
                    }
                ],
                structured_response_schema={"type": "object", "properties": {"ok": {"type": "boolean"}}},
                timeout_override=timeout_seconds,
            )
            await asyncio.wait_for(
                gateway.generate(request, tools=(_TEST_TOOL,)), timeout=timeout_seconds
            )
        except ModelGatewayError as exc:
            logger.warning(
                "Tenant model configuration test failed tenant=%s provider=%s model=%s retryable=%s",
                tenant_id,
                spec.provider,
                model.strip(),
                exc.retryable,
            )
            raise ModelConfigTestError from exc
        except (TimeoutError, asyncio.TimeoutError) as exc:
            logger.warning(
                "Tenant model configuration test timed out tenant=%s provider=%s model=%s",
                tenant_id,
                spec.provider,
                model.strip(),
            )
            raise ModelConfigTestError from exc
        except Exception as exc:
            # Provider SDKs should be mapped by their adapters. Keep this
            # final guard so an unexpected SDK exception still cannot cross
            # the API boundary or be returned with credentials in its text.
            logger.warning(
                "Tenant model configuration test raised an unmapped provider error "
                "tenant=%s provider=%s model=%s type=%s",
                tenant_id,
                spec.provider,
                model.strip(),
                type(exc).__name__,
            )
            raise ModelConfigTestError from exc


def provider_is_configured(provider: str | None, settings: AgentSettings) -> bool:
    if not provider:
        return False
    try:
        return is_provider_configured(get_provider_spec(provider), settings)
    except ProviderCatalogError:
        return False


def repository_from_session_factory(
    session_factory: object,
) -> SqlAlchemyProviderConfigRepository:
    """Typed construction helper kept at the HTTP/application boundary."""

    return SqlAlchemyProviderConfigRepository(session_factory)  # type: ignore[arg-type]


__all__ = [
    "ALLOWED_PARAMETER_KEYS",
    "MODEL_CONFIG_MANAGE",
    "MODEL_CONFIG_READ",
    "ModelConfigTestError",
    "ModelConfigValidationError",
    "ProviderConfigRepository",
    "ProviderConfigService",
    "ProviderConfigVersionConflictError",
    "ProviderNotConfiguredError",
    "has_model_config_permission",
    "normalize_parameters",
    "provider_is_configured",
    "repository_from_session_factory",
]
