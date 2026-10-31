from __future__ import annotations

import logging
import time
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Header, Query, status

from logix_forecast.config import settings
from logix_forecast.modules.forecasts.persistence import (
    try_load_demand_observations,
    try_save_forecast_run,
)
from logix_forecast.modules.forecasts.schemas import (
    DEFAULT_PRODUCT_ID,
    DEFAULT_TENANT_ID,
    DEFAULT_WAREHOUSE_ID,
    ForecastMetricsComparisonOut,
    ForecastRunOut,
    ForecastRunRequest,
    StockoutRisksResponseOut,
)
from logix_forecast.modules.forecasts.service import ForecastEngineService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/forecast", tags=["Demand Forecasting"])
forecast_service = ForecastEngineService()


def _resolve_tenant_id(
    x_tenant_id: str | None, fallback: UUID = DEFAULT_TENANT_ID
) -> UUID:
    if not x_tenant_id:
        return fallback
    try:
        return UUID(x_tenant_id)
    except ValueError:
        return fallback


@router.post(
    "/runs",
    response_model=ForecastRunOut,
    status_code=status.HTTP_200_OK,
    summary="Trigger 7-day SKU-warehouse demand forecast run",
)
async def create_forecast_run(
    request: ForecastRunRequest | None = None,
    x_tenant_id: Annotated[str | None, Header(alias="X-Tenant-Id")] = None,
) -> ForecastRunOut:
    req = request or ForecastRunRequest()
    tenant_uuid = _resolve_tenant_id(x_tenant_id, req.tenant_id)
    start_ts = time.perf_counter()

    db_observations = None
    if req.observations is None and settings.database_url:
        try:
            from logix_forecast.main import get_session_factory

            session_factory = get_session_factory()
            async with session_factory() as session:
                loaded = await try_load_demand_observations(
                    session,
                    tenant_id=tenant_uuid,
                    warehouse_id=req.warehouse_id,
                    product_id=req.product_id,
                )
                if loaded:
                    db_observations = loaded
        except Exception as exc:  # noqa: BLE001
            logger.warning("Skipping DB observation lookup: %s", exc)

    result = forecast_service.compute_forecast(req, db_observations=db_observations)
    elapsed_ms = int((time.perf_counter() - start_ts) * 1000)

    if settings.database_url:
        try:
            from logix_forecast.main import get_session_factory

            session_factory = get_session_factory()
            async with session_factory() as session:
                await try_save_forecast_run(
                    session,
                    req,
                    result,
                    tenant_id=tenant_uuid,
                    latency_ms=elapsed_ms,
                )
        except Exception as exc:  # noqa: BLE001
            logger.warning("Could not persist forecast run: %s", exc)

    return result


@router.get(
    "/runs/{run_id}",
    response_model=ForecastRunOut,
    summary="Get forecast run by ID",
)
async def get_forecast_run(
    run_id: UUID,
    x_tenant_id: Annotated[str | None, Header(alias="X-Tenant-Id")] = None,
) -> ForecastRunOut:
    _ = _resolve_tenant_id(x_tenant_id)
    return forecast_service.compute_forecast(ForecastRunRequest(), run_id=run_id)


@router.get(
    "/results",
    response_model=ForecastRunOut,
    summary="Get 7-day demand forecast and confidence bounds for a SKU-warehouse pair",
)
async def get_forecast_results(
    warehouse_id: UUID = DEFAULT_WAREHOUSE_ID,
    product_id: UUID = DEFAULT_PRODUCT_ID,
    horizon_days: Annotated[int, Query(ge=1, le=30)] = 7,
    available_stock: Annotated[float, Query(ge=0.0)] = 280.0,
    x_tenant_id: Annotated[str | None, Header(alias="X-Tenant-Id")] = None,
) -> ForecastRunOut:
    tenant_uuid = _resolve_tenant_id(x_tenant_id)
    req = ForecastRunRequest(
        tenant_id=tenant_uuid,
        warehouse_id=warehouse_id,
        product_id=product_id,
        horizon_days=horizon_days,
        available_stock=available_stock,
    )
    return forecast_service.compute_forecast(req)


@router.get(
    "/metrics",
    response_model=ForecastMetricsComparisonOut,
    summary="Compare Meta Prophet vs Moving Average 7 and Naive baseline accuracy (RMSE, MAPE, MAE)",
)
async def get_forecast_metrics(
    warehouse_id: UUID = DEFAULT_WAREHOUSE_ID,
    product_id: UUID = DEFAULT_PRODUCT_ID,
    horizon_days: Annotated[int, Query(ge=1, le=30)] = 7,
    x_tenant_id: Annotated[str | None, Header(alias="X-Tenant-Id")] = None,
) -> ForecastMetricsComparisonOut:
    tenant_uuid = _resolve_tenant_id(x_tenant_id)
    req = ForecastRunRequest(
        tenant_id=tenant_uuid,
        warehouse_id=warehouse_id,
        product_id=product_id,
        horizon_days=horizon_days,
    )
    run_out = forecast_service.compute_forecast(req)
    return forecast_service.build_metrics_comparison(run_out)


@router.get(
    "/stockout-risks",
    response_model=StockoutRisksResponseOut,
    summary="Evaluate 7-day stockout risks across warehouse SKUs",
)
async def get_stockout_risks(
    warehouse_id: UUID = DEFAULT_WAREHOUSE_ID,
    horizon_days: Annotated[int, Query(ge=1, le=30)] = 7,
    x_tenant_id: Annotated[str | None, Header(alias="X-Tenant-Id")] = None,
) -> StockoutRisksResponseOut:
    _ = _resolve_tenant_id(x_tenant_id)
    return forecast_service.evaluate_stockout_risks(
        warehouse_id=warehouse_id,
        horizon_days=horizon_days,
    )
