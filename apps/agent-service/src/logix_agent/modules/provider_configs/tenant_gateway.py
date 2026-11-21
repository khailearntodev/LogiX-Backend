"""Tenant-aware ModelGateway resolver.

The graph keeps using the provider-neutral gateway port.  This wrapper resolves
the active tenant selection at the start of an execution and binds that
selection to the execution id, so an admin update cannot change a stream or a
multi-step planner run in flight.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator, Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Protocol

from logix_agent.config import AgentSettings
from logix_agent.modules.ai.contracts import (
    ModelRequest,
    ModelResponse,
    ModelStreamChunk,
    ToolDefinition,
)
from logix_agent.modules.ai.errors import ModelGatewayError
from logix_agent.modules.ai.factory import create_model_gateway
from logix_agent.modules.ai.ports import ModelGateway
from logix_agent.modules.provider_configs.catalog import (
    ProviderCatalogError,
    ProviderSpec,
    validate_model_for_provider,
)
from logix_agent.modules.provider_configs.models import LlmProviderConfig
from logix_agent.modules.provider_configs.service import (
    ProviderConfigRepository,
    normalize_parameters,
)

logger = logging.getLogger(__name__)


class TenantModelConfigurationError(ModelGatewayError):
    """The tenant has no valid active model selection."""

    retryable = False

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(message, retryable=False)


@dataclass(frozen=True, slots=True)
class ResolvedTenantModel:
    tenant_id: str
    provider: str
    model: str
    version: int
    parameters: Mapping[str, Any]
    spec: ProviderSpec
    gateway: ModelGateway


class TenantModelResolver(Protocol):
    async def begin_execution(self, tenant_id: str, execution_id: str) -> ResolvedTenantModel: ...

    async def resolve(self, tenant_id: str) -> ResolvedTenantModel: ...

    def release_execution(self, tenant_id: str, execution_id: str) -> None: ...


class TenantAwareModelGateway:
    """Resolve one configured provider/model per tenant and execution."""

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
        self._execution_bindings: dict[tuple[str, str], ResolvedTenantModel] = {}

    async def _resolve_row(self, tenant_id: str) -> ResolvedTenantModel:
        row = await self._repository.get_active(tenant_id)
        if row is None:
            raise TenantModelConfigurationError(
                "MODEL_CONFIG_REQUIRED",
                "Tenant model configuration is required before using the agent",
            )
        try:
            spec = validate_model_for_provider(row.provider, row.model, self._settings)
            parameters = normalize_parameters(row.parameters)
        except ProviderCatalogError as exc:
            code = (
                "MODEL_CONFIG_PROVIDER_NOT_CONFIGURED"
                if "not configured" in str(exc)
                else "MODEL_CONFIG_INVALID"
            )
            raise TenantModelConfigurationError(code, "Tenant model configuration is not available") from exc
        except ValueError as exc:
            raise TenantModelConfigurationError(
                "MODEL_CONFIG_INVALID", "Tenant model configuration is not valid"
            ) from exc

        gateway_settings = self._settings.model_copy(
            update={
                "llm_gateway_backend": spec.gateway_backend,
                "planner_default_model": row.model,
                "llm_timeout_seconds": parameters.get(
                    "timeout_seconds", self._settings.llm_timeout_seconds
                ),
                "llm_max_attempts": parameters.get(
                    "max_attempts", self._settings.llm_max_attempts
                ),
                "llm_fallback_enabled": False,
            }
        )
        gateway = self._gateway_factory(gateway_settings)
        return ResolvedTenantModel(
            tenant_id=tenant_id,
            provider=spec.provider,
            model=row.model,
            version=row.version,
            parameters=parameters,
            spec=spec,
            gateway=gateway,
        )

    async def resolve(self, tenant_id: str) -> ResolvedTenantModel:
        return await self._resolve_row(tenant_id)

    async def begin_execution(self, tenant_id: str, execution_id: str) -> ResolvedTenantModel:
        resolved = await self._resolve_row(tenant_id)
        self._execution_bindings[(tenant_id, execution_id)] = resolved
        logger.info(
            "Bound tenant model configuration tenant=%s execution=%s provider=%s model=%s version=%s",
            tenant_id,
            execution_id,
            resolved.provider,
            resolved.model,
            resolved.version,
        )
        return resolved

    def release_execution(self, tenant_id: str, execution_id: str) -> None:
        self._execution_bindings.pop((tenant_id, execution_id), None)

    async def _for_request(self, request: ModelRequest) -> ResolvedTenantModel:
        if request.execution_id:
            bound = self._execution_bindings.get((request.tenant_id, request.execution_id))
            if bound is not None:
                return bound
        return await self._resolve_row(request.tenant_id)

    async def generate(
        self,
        request: ModelRequest,
        *,
        tools: Sequence[ToolDefinition] = (),
    ) -> ModelResponse:
        resolved = await self._for_request(request)
        return await resolved.gateway.generate(request, tools=tools)

    async def stream(
        self,
        request: ModelRequest,
        *,
        tools: Sequence[ToolDefinition] = (),
    ) -> AsyncIterator[ModelStreamChunk]:
        resolved = await self._for_request(request)
        async for chunk in resolved.gateway.stream(request, tools=tools):
            yield chunk


__all__ = [
    "ResolvedTenantModel",
    "TenantAwareModelGateway",
    "TenantModelConfigurationError",
    "TenantModelResolver",
]
