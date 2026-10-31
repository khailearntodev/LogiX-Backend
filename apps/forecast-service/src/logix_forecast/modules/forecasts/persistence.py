from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime
from decimal import Decimal
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from logix_forecast.engine.schemas import DemandObservationIn
from logix_forecast.modules.demand.models import DemandObservation
from logix_forecast.modules.forecasts.models import (
    ForecastMetric,
    ForecastResult,
    ForecastRun,
    ForecastSeries,
)
from logix_forecast.modules.forecasts.schemas import (
    DEFAULT_TENANT_ID,
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
    try:
        actual_tenant_id = tenant_id or request.tenant_id or DEFAULT_TENANT_ID
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
                model_metadata=dict(pt.model_metadata),
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
