from __future__ import annotations

import base64
import json
import logging
import time
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Header, HTTPException, Query, status

from logix_forecast.config import settings
from logix_forecast.engine.schemas import DemandObservationIn
from logix_forecast.modules.forecasts.persistence import (
    try_load_demand_observations,
    try_load_forecast_run_by_id,
    try_load_warehouse_demand_series,
    try_save_forecast_run,
)
from logix_forecast.modules.forecasts.schemas import (
    ForecastMetricsComparisonOut,
    ForecastRunOut,
    ForecastRunRequest,
    StockoutRisksResponseOut,
)
from logix_forecast.modules.forecasts.service import ForecastEngineService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/forecast", tags=["Demand Forecasting"])
forecast_service = ForecastEngineService()


def _extract_tenant_from_jwt(authorization: str | None) -> UUID | None:
    if not authorization or not authorization.lower().startswith("bearer "):
        return None
    token = authorization[7:].strip()
    parts = token.split(".")
    if len(parts) < 2:
        return None
    try:
        payload_b64 = parts[1] + "=" * (-len(parts[1]) % 4)
        payload = json.loads(base64.urlsafe_b64decode(payload_b64).decode("utf-8"))
        if isinstance(payload, dict):
            raw_tid = payload.get("tenantId") or payload.get("tenant_id")
            if isinstance(raw_tid, str):
                return UUID(raw_tid)
    except Exception:  # noqa: BLE001
        return None
    return None


def _resolve_tenant_id(
    x_tenant_id: str | None,
    authorization: str | None = None,
    body_tenant_id: UUID | None = None,
) -> UUID:
    if x_tenant_id:
        try:
            return UUID(x_tenant_id)
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid X-Tenant-Id UUID header",
            ) from exc
    jwt_tid = _extract_tenant_from_jwt(authorization)
    if jwt_tid is not None:
        return jwt_tid
    if body_tenant_id is not None:
        return body_tenant_id
    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail="Missing or invalid tenant_id (provide X-Tenant-Id header, Bearer token, or tenant_id in request)",
    )


async def _load_observations_from_db(
    tenant_id: UUID,
    warehouse_id: UUID,
    product_id: UUID,
) -> list[DemandObservationIn]:
    if not settings.database_url:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Forecast database is not configured",
        )
    try:
        from logix_forecast.main import get_session_factory

        session_factory = get_session_factory()
        async with session_factory() as session:
            return await try_load_demand_observations(
                session,
                tenant_id=tenant_id,
                warehouse_id=warehouse_id,
                product_id=product_id,
            )
    except Exception as exc:  # noqa: BLE001
        logger.warning("Could not query demand observations from DB: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Failed to load demand observations from database",
        ) from exc


async def _persist_run_if_configured(
    req: ForecastRunRequest,
    result: ForecastRunOut,
    *,
    tenant_id: UUID,
    latency_ms: int,
) -> None:
    if not settings.database_url:
        return
    try:
        from logix_forecast.main import get_session_factory

        session_factory = get_session_factory()
        async with session_factory() as session:
            await try_save_forecast_run(
                session,
                req,
                result,
                tenant_id=tenant_id,
                latency_ms=latency_ms,
            )
    except Exception as exc:  # noqa: BLE001
        logger.warning("Could not persist forecast run: %s", exc)


@router.post(
    "/runs",
    response_model=ForecastRunOut,
    status_code=status.HTTP_200_OK,
    summary="Trigger 7-day SKU-warehouse demand forecast run",
)
async def create_forecast_run(
    request: ForecastRunRequest,
    x_tenant_id: Annotated[str | None, Header(alias="X-Tenant-Id")] = None,
    authorization: Annotated[str | None, Header(alias="Authorization")] = None,
) -> ForecastRunOut:
    tenant_uuid = _resolve_tenant_id(x_tenant_id, authorization, request.tenant_id)
    start_ts = time.perf_counter()

    db_observations: list[DemandObservationIn] | None = None
    if request.observations is None:
        db_observations = await _load_observations_from_db(
            tenant_uuid, request.warehouse_id, request.product_id
        )

    result = forecast_service.compute_forecast(request, db_observations=db_observations)
    elapsed_ms = int((time.perf_counter() - start_ts) * 1000)

    if result.status == "SUCCEEDED":
        await _persist_run_if_configured(
            request, result, tenant_id=tenant_uuid, latency_ms=elapsed_ms
        )

    return result


@router.get(
    "/runs/{run_id}",
    response_model=ForecastRunOut,
    summary="Get forecast run by ID",
)
async def get_forecast_run(
    run_id: UUID,
    x_tenant_id: Annotated[str | None, Header(alias="X-Tenant-Id")] = None,
    authorization: Annotated[str | None, Header(alias="Authorization")] = None,
) -> ForecastRunOut:
    tenant_uuid = _resolve_tenant_id(x_tenant_id, authorization)

    if not settings.database_url:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Forecast database is not configured",
        )

    from logix_forecast.main import get_session_factory

    session_factory = get_session_factory()
    async with session_factory() as session:
        existing = await try_load_forecast_run_by_id(
            session, tenant_id=tenant_uuid, run_id=run_id
        )

    if existing is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Forecast run {run_id} not found",
        )
    return existing


@router.get(
    "/results",
    response_model=ForecastRunOut,
    summary="Get 7-day demand forecast and confidence bounds for a SKU-warehouse pair",
)
async def get_forecast_results(
    warehouse_id: UUID,
    product_id: UUID,
    horizon_days: Annotated[int, Query(ge=1, le=30)] = 7,
    available_stock: Annotated[float, Query(ge=0.0)] = 0.0,
    warehouse_name: str = "",
    sku_code: str = "",
    product_name: str = "",
    x_tenant_id: Annotated[str | None, Header(alias="X-Tenant-Id")] = None,
    authorization: Annotated[str | None, Header(alias="Authorization")] = None,
) -> ForecastRunOut:
    tenant_uuid = _resolve_tenant_id(x_tenant_id, authorization)
    req = ForecastRunRequest(
        tenant_id=tenant_uuid,
        warehouse_id=warehouse_id,
        product_id=product_id,
        warehouse_name=warehouse_name,
        sku_code=sku_code,
        product_name=product_name,
        horizon_days=horizon_days,
        available_stock=available_stock,
    )
    start_ts = time.perf_counter()
    db_observations = await _load_observations_from_db(
        tenant_uuid, warehouse_id, product_id
    )
    result = forecast_service.compute_forecast(req, db_observations=db_observations)
    elapsed_ms = int((time.perf_counter() - start_ts) * 1000)

    if result.status == "SUCCEEDED":
        await _persist_run_if_configured(
            req, result, tenant_id=tenant_uuid, latency_ms=elapsed_ms
        )
    return result


@router.get(
    "/metrics",
    response_model=ForecastMetricsComparisonOut,
    summary="Compare Meta Prophet vs Moving Average 7 and Naive baseline accuracy (RMSE, MAPE, MAE)",
)
async def get_forecast_metrics(
    warehouse_id: UUID,
    product_id: UUID,
    horizon_days: Annotated[int, Query(ge=1, le=30)] = 7,
    x_tenant_id: Annotated[str | None, Header(alias="X-Tenant-Id")] = None,
    authorization: Annotated[str | None, Header(alias="Authorization")] = None,
) -> ForecastMetricsComparisonOut:
    tenant_uuid = _resolve_tenant_id(x_tenant_id, authorization)
    req = ForecastRunRequest(
        tenant_id=tenant_uuid,
        warehouse_id=warehouse_id,
        product_id=product_id,
        horizon_days=horizon_days,
    )
    db_observations = await _load_observations_from_db(
        tenant_uuid, warehouse_id, product_id
    )
    run_out = forecast_service.compute_forecast(req, db_observations=db_observations)
    return forecast_service.build_metrics_comparison(run_out)


@router.get(
    "/stockout-risks",
    response_model=StockoutRisksResponseOut,
    summary="Evaluate 7-day stockout risks across warehouse SKUs",
)
async def get_stockout_risks(
    warehouse_id: UUID,
    horizon_days: Annotated[int, Query(ge=1, le=30)] = 7,
    x_tenant_id: Annotated[str | None, Header(alias="X-Tenant-Id")] = None,
    authorization: Annotated[str | None, Header(alias="Authorization")] = None,
) -> StockoutRisksResponseOut:
    tenant_uuid = _resolve_tenant_id(x_tenant_id, authorization)
    if not settings.database_url:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Forecast database is not configured",
        )

    try:
        from logix_forecast.main import get_session_factory

        session_factory = get_session_factory()
        async with session_factory() as session:
            db_series_by_product = await try_load_warehouse_demand_series(
                session,
                tenant_id=tenant_uuid,
                warehouse_id=warehouse_id,
            )
    except Exception as exc:  # noqa: BLE001
        logger.warning("Could not query warehouse demand series from DB: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Failed to load warehouse demand series from database",
        ) from exc

    return forecast_service.evaluate_stockout_risks(
        warehouse_id=warehouse_id,
        horizon_days=horizon_days,
        db_series_by_product=db_series_by_product,
    )
