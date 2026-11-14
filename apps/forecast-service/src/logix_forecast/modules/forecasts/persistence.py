from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime
from decimal import Decimal
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from logix_forecast.engine.schemas import (
    DailyForecastPointOut,
    DemandObservationIn,
    MethodMetricsOut,
)
from logix_forecast.modules.demand.models import DemandObservation
from logix_forecast.modules.forecasts.models import (
    ForecastMetric,
    ForecastResult,
    ForecastRun,
    ForecastSeries,
)
from logix_forecast.modules.forecasts.schemas import (
    ForecastRunOut,
    ForecastRunRequest,
)
from logix_forecast.modules.messaging.models import OutboxEvent

logger = logging.getLogger(__name__)


async def try_load_demand_observations(
    session: AsyncSession,
    *,
    tenant_id: UUID,
    warehouse_id: UUID,
    product_id: UUID,
) -> list[DemandObservationIn]:
    """Loads historical demand observations for a (tenant, warehouse, product) series."""
    try:
        stmt = (
            select(DemandObservation)
            .where(
                DemandObservation.tenant_id == tenant_id,
                DemandObservation.warehouse_id == warehouse_id,
                DemandObservation.product_id == product_id,
                DemandObservation.deleted_at.is_(None),
            )
            .order_by(DemandObservation.demand_date.asc())
        )
        rows = (await session.execute(stmt)).scalars().all()
        return [
            DemandObservationIn(
                demand_date=row.demand_date,
                fulfilled_quantity=float(row.fulfilled_quantity),
            )
            for row in rows
        ]
    except Exception as exc:  # noqa: BLE001
        logger.warning("Could not query demand_observations from DB: %s", exc)
        return []


async def try_load_warehouse_demand_series(
    session: AsyncSession,
    *,
    tenant_id: UUID,
    warehouse_id: UUID,
) -> dict[UUID, list[DemandObservationIn]]:
    """Loads all SKU demand observation series for a warehouse grouped by product_id."""
    try:
        stmt = (
            select(DemandObservation)
            .where(
                DemandObservation.tenant_id == tenant_id,
                DemandObservation.warehouse_id == warehouse_id,
                DemandObservation.deleted_at.is_(None),
            )
            .order_by(
                DemandObservation.product_id.asc(),
                DemandObservation.demand_date.asc(),
            )
        )
        rows = (await session.execute(stmt)).scalars().all()

        grouped: dict[UUID, list[DemandObservationIn]] = {}
        for row in rows:
            grouped.setdefault(row.product_id, []).append(
                DemandObservationIn(
                    demand_date=row.demand_date,
                    fulfilled_quantity=float(row.fulfilled_quantity),
                )
            )
        return grouped
    except Exception as exc:  # noqa: BLE001
        logger.warning("Could not query warehouse demand series from DB: %s", exc)
        return {}


async def _hydrate_forecast_run_out(
    session: AsyncSession,
    run_row: ForecastRun,
    series_row: ForecastSeries,
) -> ForecastRunOut:
    res_stmt = (
        select(ForecastResult)
        .where(
            ForecastResult.tenant_id == run_row.tenant_id,
            ForecastResult.forecast_series_id == series_row.id,
            ForecastResult.deleted_at.is_(None),
        )
        .order_by(ForecastResult.forecast_date.asc())
    )
    result_rows = (await session.execute(res_stmt)).scalars().all()

    metric_stmt = select(ForecastMetric).where(
        ForecastMetric.tenant_id == run_row.tenant_id,
        ForecastMetric.forecast_series_id == series_row.id,
        ForecastMetric.deleted_at.is_(None),
    )
    metric_rows = (await session.execute(metric_stmt)).scalars().all()

    forecast_points: list[DailyForecastPointOut] = []
    for row in result_rows:
        meta = dict(row.model_metadata or {})
        raw_snaive = meta.get("baseline_seasonal_naive_7")
        raw_trend = meta.get("trend_component")
        raw_weekly = meta.get("weekly_component")
        pred = float(row.predicted_quantity)
        low = float(row.lower_bound) if row.lower_bound is not None else pred
        high = float(row.upper_bound) if row.upper_bound is not None else pred
        forecast_points.append(
            DailyForecastPointOut(
                forecast_date=row.forecast_date,
                predicted_quantity=pred,
                lower_bound=low,
                upper_bound=max(low, high),
                baseline_naive=(
                    float(row.baseline_naive) if row.baseline_naive is not None else 0.0
                ),
                baseline_moving_average_7=(
                    float(row.baseline_moving_average_7)
                    if row.baseline_moving_average_7 is not None
                    else 0.0
                ),
                baseline_seasonal_naive_7=(
                    float(raw_snaive) if isinstance(raw_snaive, (int, float)) else 0.0
                ),
                confidence_level=float(row.confidence_level),
                trend_component=(
                    float(raw_trend) if isinstance(raw_trend, (int, float)) else None
                ),
                weekly_component=(
                    float(raw_weekly) if isinstance(raw_weekly, (int, float)) else None
                ),
                model_metadata=meta,
            )
        )

    params = dict(run_row.parameters or {})
    mae_raw = params.get("mae_by_method")
    mae_map: dict[str, object] = mae_raw if isinstance(mae_raw, dict) else {}

    grouped_metrics: dict[tuple[str, str], dict[str, ForecastMetric]] = {}
    for m_row in metric_rows:
        key = (m_row.method_name, m_row.method_type)
        grouped_metrics.setdefault(key, {})[m_row.metric_name] = m_row

    metrics: list[MethodMetricsOut] = []
    for (method_name, method_type), pair in grouped_metrics.items():
        rmse_row = pair.get("RMSE")
        mape_row = pair.get("MAPE")
        ref_row = mape_row or rmse_row
        if ref_row is None:
            continue
        raw_mae = mae_map.get(method_name, 0.0)
        mae_val = float(raw_mae) if isinstance(raw_mae, (int, float)) else 0.0
        metrics.append(
            MethodMetricsOut(
                method_name=method_name,
                method_type=method_type,  # type: ignore[arg-type]
                rmse=(
                    float(rmse_row.metric_value)
                    if rmse_row is not None and rmse_row.metric_value is not None
                    else 0.0
                ),
                mape=(
                    float(mape_row.metric_value)
                    if mape_row is not None and mape_row.metric_value is not None
                    else None
                ),
                mae=mae_val,
                zero_actual_policy=ref_row.zero_actual_policy,
                eligible_point_count=ref_row.eligible_point_count,
                total_point_count=ref_row.total_point_count,
                evaluation_start_date=ref_row.evaluation_start_date,
                evaluation_end_date=ref_row.evaluation_end_date,
            )
        )

    warehouse_name = str(params.get("warehouse_name") or "")
    sku_code = str(params.get("sku_code") or "")
    product_name = str(params.get("product_name") or "")
    raw_stock = params.get("available_stock")
    available_stock = float(raw_stock) if isinstance(raw_stock, (int, float)) else 0.0

    total_pred = (
        float(params["total_predicted_7d"])
        if isinstance(params.get("total_predicted_7d"), (int, float))
        else round(sum(pt.predicted_quantity for pt in forecast_points), 3)
    )
    total_upper = (
        float(params["total_upper_bound_7d"])
        if isinstance(params.get("total_upper_bound_7d"), (int, float))
        else round(sum(pt.upper_bound for pt in forecast_points), 3)
    )
    shortfall = (
        float(params["shortfall_quantity"])
        if isinstance(params.get("shortfall_quantity"), (int, float))
        else max(0.0, round(total_pred - available_stock, 3))
    )
    stockout_risk = (
        bool(params["stockout_risk"])
        if isinstance(params.get("stockout_risk"), bool)
        else shortfall > 0.0
    )
    recommended_action = (
        str(params["recommended_action"])
        if isinstance(params.get("recommended_action"), str)
        else (
            f"Stockout risk detected: {run_row.horizon_days}-day forecast requires {total_pred:.1f} units "
            f"(upper bound {total_upper:.1f}), exceeding available stock ({available_stock:.1f})."
            if stockout_risk
            else f"Stock level is sufficient: available stock ({available_stock:.1f}) "
            f"covers the {run_row.horizon_days}-day predicted demand ({total_pred:.1f} units)."
        )
    )

    return ForecastRunOut(
        forecast_run_id=run_row.id,
        forecast_series_id=series_row.id,
        warehouse_id=series_row.warehouse_id,
        warehouse_name=warehouse_name,
        product_id=series_row.product_id,
        sku_code=sku_code,
        product_name=product_name,
        status=series_row.status,
        model_name=run_row.model_name,
        used_fallback=series_row.used_fallback,
        fallback_reason=series_row.fallback_reason,
        confidence_level=float(series_row.confidence_level),
        observation_count=series_row.observation_count,
        training_start_date=run_row.training_start_date,
        training_end_date=run_row.training_end_date,
        horizon_days=run_row.horizon_days,
        dataset_hash=run_row.dataset_hash,
        total_predicted_7d=total_pred,
        total_upper_bound_7d=total_upper,
        available_stock=available_stock,
        stockout_risk=stockout_risk,
        shortfall_quantity=shortfall,
        recommended_action=recommended_action,
        forecast_points=forecast_points,
        metrics=metrics,
    )


async def try_load_forecast_run_by_id(
    session: AsyncSession,
    *,
    tenant_id: UUID,
    run_id: UUID,
) -> ForecastRunOut | None:
    """Loads a persisted forecast run with its series, points, and metrics by run_id."""
    try:
        run_stmt = select(ForecastRun).where(
            ForecastRun.id == run_id,
            ForecastRun.tenant_id == tenant_id,
            ForecastRun.deleted_at.is_(None),
        )
        run_row = (await session.execute(run_stmt)).scalars().first()
        if run_row is None:
            return None

        series_stmt = select(ForecastSeries).where(
            ForecastSeries.tenant_id == run_row.tenant_id,
            ForecastSeries.forecast_run_id == run_row.id,
            ForecastSeries.deleted_at.is_(None),
        )
        series_row = (await session.execute(series_stmt)).scalars().first()
        if series_row is None:
            return None

        return await _hydrate_forecast_run_out(session, run_row, series_row)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Could not load forecast run %s from DB: %s", run_id, exc)
        return None


async def try_load_latest_forecast_run(
    session: AsyncSession,
    *,
    tenant_id: UUID,
    warehouse_id: UUID,
    product_id: UUID,
    horizon_days: int,
) -> ForecastRunOut | None:
    """Loads the most recent SUCCEEDED forecast run for a (tenant, warehouse, product, horizon)."""
    try:
        stmt = (
            select(ForecastRun, ForecastSeries)
            .join(
                ForecastSeries,
                (ForecastSeries.tenant_id == ForecastRun.tenant_id)
                & (ForecastSeries.forecast_run_id == ForecastRun.id),
            )
            .where(
                ForecastRun.tenant_id == tenant_id,
                ForecastRun.status == "SUCCEEDED",
                ForecastRun.horizon_days == horizon_days,
                ForecastRun.deleted_at.is_(None),
                ForecastSeries.warehouse_id == warehouse_id,
                ForecastSeries.product_id == product_id,
                ForecastSeries.deleted_at.is_(None),
            )
            .order_by(ForecastRun.created_at.desc())
            .limit(1)
        )
        pair = (await session.execute(stmt)).first()
        if pair is None:
            return None
        run_row, series_row = pair
        return await _hydrate_forecast_run_out(session, run_row, series_row)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Could not load latest forecast run from DB: %s", exc)
        return None


async def try_save_forecast_run(
    session: AsyncSession,
    request: ForecastRunRequest,
    result: ForecastRunOut,
    *,
    tenant_id: UUID | None = None,
    latency_ms: int = 120,
) -> UUID | None:
    """
    Persists ForecastRun, ForecastSeries, ForecastResult rows, ForecastMetric rows
    (MAPE & RMSE), and a ForecastCompleted OutboxEvent in a single DB transaction.
    """
    actual_tenant_id = tenant_id or request.tenant_id
    if actual_tenant_id is None:
        raise ValueError("tenant_id is required to persist a forecast run")
    try:
        run_id = result.forecast_run_id
        series_id = result.forecast_series_id
        correlation_id = uuid.uuid4()
        now = datetime.now(UTC)

        run_row = ForecastRun(
            id=run_id,
            tenant_id=actual_tenant_id,
            status="SUCCEEDED",
            trigger_type="API",
            requested_by=None,
            horizon_days=result.horizon_days,
            training_start_date=result.training_start_date,
            training_end_date=result.training_end_date,
            model_name=result.model_name,
            model_version="1.5.0",
            baseline_name="Moving Average 7",
            parameters={
                "warehouse_name": result.warehouse_name,
                "sku_code": result.sku_code,
                "product_name": result.product_name,
                "available_stock": result.available_stock,
                "total_predicted_7d": result.total_predicted_7d,
                "total_upper_bound_7d": result.total_upper_bound_7d,
                "stockout_risk": result.stockout_risk,
                "shortfall_quantity": result.shortfall_quantity,
                "recommended_action": result.recommended_action,
                "mae_by_method": {m.method_name: m.mae for m in result.metrics},
            },
            dataset_hash=result.dataset_hash,
            random_seed=42,
            correlation_id=correlation_id,
            idempotency_key=request.idempotency_key,
            started_at=now,
            completed_at=now,
            latency_ms=max(0, latency_ms),
        )
        session.add(run_row)

        series_row = ForecastSeries(
            id=series_id,
            tenant_id=actual_tenant_id,
            forecast_run_id=run_id,
            warehouse_id=result.warehouse_id,
            product_id=result.product_id,
            status=result.status,
            observation_count=result.observation_count,
            confidence_level=Decimal(str(round(result.confidence_level, 4))),
            used_fallback=result.used_fallback,
            fallback_reason=result.fallback_reason,
        )
        session.add(series_row)

        for pt in result.forecast_points:
            res_row = ForecastResult(
                id=uuid.uuid4(),
                tenant_id=actual_tenant_id,
                forecast_series_id=series_id,
                forecast_date=pt.forecast_date,
                predicted_quantity=Decimal(str(round(pt.predicted_quantity, 3))),
                lower_bound=Decimal(str(round(pt.lower_bound, 3))),
                upper_bound=Decimal(str(round(pt.upper_bound, 3))),
                baseline_naive=Decimal(str(round(pt.baseline_naive, 3))),
                baseline_moving_average_7=Decimal(
                    str(round(pt.baseline_moving_average_7, 3))
                ),
                confidence_level=Decimal(str(round(pt.confidence_level, 4))),
                model_metadata={
                    **dict(pt.model_metadata),
                    "baseline_seasonal_naive_7": pt.baseline_seasonal_naive_7,
                    "trend_component": pt.trend_component,
                    "weekly_component": pt.weekly_component,
                },
            )
            session.add(res_row)

        for m in result.metrics:
            session.add(
                ForecastMetric(
                    id=uuid.uuid4(),
                    tenant_id=actual_tenant_id,
                    forecast_series_id=series_id,
                    metric_name="RMSE",
                    metric_value=Decimal(str(round(m.rmse, 6))),
                    method_type=m.method_type,
                    method_name=m.method_name,
                    evaluation_start_date=m.evaluation_start_date,
                    evaluation_end_date=m.evaluation_end_date,
                    zero_actual_policy=m.zero_actual_policy,
                    eligible_point_count=m.total_point_count,
                    total_point_count=m.total_point_count,
                    calculated_at=now,
                )
            )
            session.add(
                ForecastMetric(
                    id=uuid.uuid4(),
                    tenant_id=actual_tenant_id,
                    forecast_series_id=series_id,
                    metric_name="MAPE",
                    metric_value=(
                        Decimal(str(round(m.mape, 6))) if m.mape is not None else None
                    ),
                    method_type=m.method_type,
                    method_name=m.method_name,
                    evaluation_start_date=m.evaluation_start_date,
                    evaluation_end_date=m.evaluation_end_date,
                    zero_actual_policy=m.zero_actual_policy,
                    eligible_point_count=m.eligible_point_count,
                    total_point_count=m.total_point_count,
                    calculated_at=now,
                )
            )

        outbox = OutboxEvent(
            id=uuid.uuid4(),
            tenant_id=actual_tenant_id,
            event_type="ForecastCompleted",
            event_version=1,
            aggregate_type="ForecastRun",
            aggregate_id=run_id,
            aggregate_version=1,
            correlation_id=correlation_id,
            payload={
                "forecast_run_id": str(run_id),
                "warehouse_id": str(result.warehouse_id),
                "product_id": str(result.product_id),
                "horizon_days": result.horizon_days,
                "total_predicted_7d": result.total_predicted_7d,
                "stockout_risk": result.stockout_risk,
            },
            occurred_at=now,
        )
        session.add(outbox)

        await session.commit()
        return run_id
    except Exception as exc:  # noqa: BLE001
        logger.warning("Could not persist forecast run to DB: %s", exc)
        await session.rollback()
        return None
