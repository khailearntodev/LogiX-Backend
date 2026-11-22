"""Tenant-scoped model configuration API."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from logix_agent.config import settings
from logix_agent.modules.auth import Actor, get_current_actor
from logix_agent.modules.provider_configs.models import LlmProviderConfig
from logix_agent.modules.provider_configs.model_catalog import (
    ModelCatalogError,
    ModelCatalogProviderNotConfiguredError,
    ModelCatalogProviderUnsupportedError,
    list_provider_models,
)
from logix_agent.modules.provider_configs.repository import (
    ProviderConfigVersionConflictError,
)
from logix_agent.modules.provider_configs.service import (
    MODEL_CONFIG_MANAGE,
    ModelConfigTestError,
    ModelConfigValidationError,
    ProviderConfigService,
    ProviderNotConfiguredError,
    has_model_config_permission,
    repository_from_session_factory,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/agent", tags=["Agent model configuration"])


class ModelConfigInput(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )

    provider: str = Field(..., min_length=1, max_length=100)
    model: str = Field(..., min_length=1, max_length=200)
    parameters: dict[str, Any] = Field(default_factory=dict)


class ModelConfigUpdate(ModelConfigInput):
    expected_version: int = Field(default=0, ge=0)


class ProviderAvailability(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    provider: str
    configured: bool
    gateway_backend: str
    model_prefix: str | None = None


class ModelConfigResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    configured: bool
    provider: str | None = None
    model: str | None = None
    parameters: dict[str, Any] = Field(default_factory=dict)
    version: int | None = None
    provider_configured: bool
    available_providers: list[ProviderAvailability]


class ModelConfigTestResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    ok: bool = True
    provider: str
    model: str


class ModelOption(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    id: str
    display_name: str


class ModelCatalogResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    provider: str
    models: list[ModelOption]


def get_provider_config_service(request: Request) -> ProviderConfigService:
    service = getattr(request.app.state, "provider_config_service", None)
    if service is not None:
        return service

    repository = getattr(request.app.state, "provider_config_repository", None)
    if repository is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="MODEL_CONFIG_STORAGE_UNAVAILABLE",
        )
    return ProviderConfigService(repository, settings=settings)


def _require_manage(actor: Actor) -> None:
    if not has_model_config_permission(actor, MODEL_CONFIG_MANAGE):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="MODEL_CONFIG_MANAGE_REQUIRED",
        )


def _public_parameters(row: LlmProviderConfig | None) -> dict[str, Any]:
    if row is None:
        return {}
    # The service only writes this allow-list. Filtering also protects the API
    # if a legacy row contains an obsolete or secret-shaped JSON key.
    result: dict[str, Any] = {}
    if "timeout_seconds" in row.parameters:
        result["timeoutSeconds"] = row.parameters["timeout_seconds"]
    if "max_attempts" in row.parameters:
        result["maxAttempts"] = row.parameters["max_attempts"]
    return result


def _response(service: ProviderConfigService, row: LlmProviderConfig | None) -> ModelConfigResponse:
    available = [
        ProviderAvailability(
            provider=spec.provider,
            configured=configured,
            gateway_backend=spec.gateway_backend,
            model_prefix=spec.model_prefix,
        )
        for spec, configured in service.catalog()
    ]
    return ModelConfigResponse(
        configured=row is not None,
        provider=row.provider if row else None,
        model=row.model if row else None,
        parameters=_public_parameters(row),
        version=row.version if row else None,
        provider_configured=service.is_provider_configured(row.provider if row else None),
        available_providers=available,
    )


@router.get("/model-config", response_model=ModelConfigResponse)
async def get_model_config(
    actor: Actor = Depends(get_current_actor),
    service: ProviderConfigService = Depends(get_provider_config_service),
) -> ModelConfigResponse:
    row = await service.get(actor.tenant_id)
    return _response(service, row)


@router.get("/model-config/models", response_model=ModelCatalogResponse)
async def get_model_catalog(
    provider: str,
    actor: Actor = Depends(get_current_actor),
) -> ModelCatalogResponse:
    if not has_model_config_permission(actor, "agent:model-config:read"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="MODEL_CONFIG_READ_REQUIRED",
        )
    try:
        models = await list_provider_models(provider, settings=settings)
    except ModelCatalogProviderNotConfiguredError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=exc.code) from None
    except ModelCatalogProviderUnsupportedError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=exc.code) from None
    except ModelCatalogError:
        logger.warning("Provider model catalog request failed for provider=%s", provider)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="MODEL_CATALOG_UNAVAILABLE") from None
    return ModelCatalogResponse(
        provider=provider.strip().lower(),
        models=models,
    )


@router.put("/model-config", response_model=ModelConfigResponse)
async def update_model_config(
    body: ModelConfigUpdate,
    actor: Actor = Depends(get_current_actor),
    service: ProviderConfigService = Depends(get_provider_config_service),
) -> ModelConfigResponse:
    _require_manage(actor)
    try:
        row = await service.save(
            tenant_id=actor.tenant_id,
            provider=body.provider,
            model=body.model,
            parameters=body.parameters,
            expected_version=body.expected_version,
        )
    except ProviderNotConfiguredError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=exc.code) from None
    except ModelConfigValidationError as exc:
        logger.info("Rejected invalid tenant model configuration: %s", exc)
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=exc.code) from None
    except ProviderConfigVersionConflictError:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="MODEL_CONFIG_VERSION_CONFLICT",
        ) from None
    return _response(service, row)


@router.post("/model-config/test", response_model=ModelConfigTestResponse)
async def test_model_config(
    body: ModelConfigInput,
    actor: Actor = Depends(get_current_actor),
    service: ProviderConfigService = Depends(get_provider_config_service),
) -> ModelConfigTestResponse:
    _require_manage(actor)
    try:
        await service.test(
            tenant_id=actor.tenant_id,
            provider=body.provider,
            model=body.model,
            parameters=body.parameters,
        )
    except ProviderNotConfiguredError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=exc.code) from None
    except ModelConfigValidationError as exc:
        logger.info("Rejected invalid tenant model configuration test: %s", exc)
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=exc.code) from None
    except ModelConfigTestError:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="MODEL_CONFIG_TEST_FAILED") from None
    return ModelConfigTestResponse(provider=body.provider.strip().lower(), model=body.model.strip())


__all__ = [
    "ModelConfigInput",
    "ModelCatalogResponse",
    "ModelOption",
    "ModelConfigResponse",
    "ModelConfigTestResponse",
    "ModelConfigUpdate",
    "ProviderAvailability",
    "get_provider_config_service",
    "router",
]
