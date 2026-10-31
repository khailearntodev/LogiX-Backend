from __future__ import annotations

import uuid
from uuid import UUID

from logix_forecast.engine.pipeline import run_series_forecast_pipeline
from logix_forecast.engine.schemas import DemandObservationIn
from logix_forecast.modules.forecasts.defaults import (
    SAMPLE_SKUS,
    build_default_observations,
)
from logix_forecast.modules.forecasts.schemas import (
    DEFAULT_WAREHOUSE_ID,
    ForecastMetricsComparisonOut,
    ForecastRunOut,
    ForecastRunRequest,
    StockoutRiskItemOut,
    StockoutRisksResponseOut,
)


class ForecastEngineService:
    """
    Service layer orchestrating demand forecasting, baseline comparison,
    and advisory stockout-risk evaluation for the MVP.
    """

    def compute_forecast(
        self,
        request: ForecastRunRequest,
        *,
        db_observations: list[DemandObservationIn] | None = None,
        run_id: UUID | None = None,
    ) -> ForecastRunOut:
        if request.observations is not None:
            observations = request.observations
        elif db_observations:
            observations = db_observations
        else:
            observations = build_default_observations()

        pipeline_res = run_series_forecast_pipeline(
            observations,
            horizon=request.horizon_days,
        )

        total_pred = round(
            sum(pt.predicted_quantity for pt in pipeline_res.forecast_points), 3
        )
        total_upper = round(
            sum(pt.upper_bound for pt in pipeline_res.forecast_points), 3
        )
        shortfall = max(0.0, round(total_pred - request.available_stock, 3))
        stockout_risk = shortfall > 0.0

        if stockout_risk:
            recommended_action = (
                f"Stockout risk detected: 7-day forecast requires {total_pred:.1f} units "
                f"(upper bound {total_upper:.1f}), exceeding available stock ({request.available_stock:.1f}). "
                f"Advisory: replenish at least {shortfall:.1f} units."
            )
        else:
            recommended_action = (
                f"Stock level is sufficient: available stock ({request.available_stock:.1f}) "
                f"covers the {request.horizon_days}-day predicted demand ({total_pred:.1f} units)."
            )

        return ForecastRunOut(
            forecast_run_id=run_id or uuid.uuid4(),
            forecast_series_id=uuid.uuid4(),
            warehouse_id=request.warehouse_id,
            warehouse_name=request.warehouse_name,
            product_id=request.product_id,
            sku_code=request.sku_code,
            product_name=request.product_name,
            status=pipeline_res.status,
            model_name=pipeline_res.model_name,
            used_fallback=pipeline_res.used_fallback,
            fallback_reason=pipeline_res.fallback_reason,
            confidence_level=pipeline_res.confidence_level,
            observation_count=pipeline_res.observation_count,
            training_start_date=pipeline_res.training_start_date,
            training_end_date=pipeline_res.training_end_date,
            horizon_days=pipeline_res.horizon_days,
            dataset_hash=pipeline_res.dataset_hash,
            total_predicted_7d=total_pred,
            total_upper_bound_7d=total_upper,
            available_stock=request.available_stock,
            stockout_risk=stockout_risk,
            shortfall_quantity=shortfall,
            recommended_action=recommended_action,
            forecast_points=pipeline_res.forecast_points,
            metrics=pipeline_res.metrics,
        )

    def build_metrics_comparison(
        self, run_out: ForecastRunOut
    ) -> ForecastMetricsComparisonOut:
        by_name = {m.method_name: m for m in run_out.metrics}
        prophet_rmse = (
            by_name["Meta Prophet"].rmse if "Meta Prophet" in by_name else None
        )
        ma7_rmse = (
            by_name["Moving Average 7"].rmse if "Moving Average 7" in by_name else None
        )
        naive_rmse = by_name["Naive"].rmse if "Naive" in by_name else None

        improvement = 0.0
        if prophet_rmse is not None and ma7_rmse and ma7_rmse > 0:
            improvement = max(
                0.0, round(((ma7_rmse - prophet_rmse) / ma7_rmse) * 100.0, 2)
            )

        summary = (
            f"Selected model: {run_out.model_name}. "
            f"RMSE comparison — Prophet: {prophet_rmse}, MA-7: {ma7_rmse}, Naive: {naive_rmse} "
            f"(improvement vs MA-7: {improvement:.2f}%)."
        )

        return ForecastMetricsComparisonOut(
            forecast_run_id=run_out.forecast_run_id,
            warehouse_id=run_out.warehouse_id,
            product_id=run_out.product_id,
            sku_code=run_out.sku_code,
            selected_model=run_out.model_name,
            used_fallback=run_out.used_fallback,
            prophet_rmse=prophet_rmse,
            baseline_ma7_rmse=ma7_rmse,
            baseline_naive_rmse=naive_rmse,
            improvement_vs_ma7_percent=improvement,
            metrics=run_out.metrics,
            analysis_summary=summary,
        )

    def evaluate_stockout_risks(
        self,
        *,
        warehouse_id: UUID = DEFAULT_WAREHOUSE_ID,
        horizon_days: int = 7,
    ) -> StockoutRisksResponseOut:
        items: list[StockoutRiskItemOut] = []
        at_risk_count = 0

        for sku in SAMPLE_SKUS:
            obs = build_default_observations(
                base_demand=float(sku["base_demand"]),  # type: ignore[arg-type]
                daily_trend=float(sku["daily_trend"]),  # type: ignore[arg-type]
            )
            req = ForecastRunRequest(
                warehouse_id=warehouse_id,
                product_id=sku["product_id"],  # type: ignore[arg-type]
                sku_code=str(sku["sku_code"]),
                product_name=str(sku["product_name"]),
                horizon_days=horizon_days,
                available_stock=float(sku["available_stock"]),  # type: ignore[arg-type]
                observations=obs,
            )
            res = self.compute_forecast(req)
            safety_shortfall = max(
                0.0, round(res.total_upper_bound_7d - res.available_stock, 3)
            )

            if res.stockout_risk:
                risk_level = "HIGH"
                at_risk_count += 1
            elif safety_shortfall > 0.0:
                risk_level = "MEDIUM"
                at_risk_count += 1
            else:
                risk_level = "LOW"

            items.append(
                StockoutRiskItemOut(
                    warehouse_id=res.warehouse_id,
                    warehouse_name=res.warehouse_name,
                    product_id=res.product_id,
                    sku_code=res.sku_code,
                    product_name=res.product_name,
                    horizon_days=res.horizon_days,
                    total_predicted_demand=res.total_predicted_7d,
                    total_upper_bound_demand=res.total_upper_bound_7d,
                    available_stock=res.available_stock,
                    shortfall_quantity=res.shortfall_quantity,
                    risk_level=risk_level,
                    recommended_replenishment=max(
                        res.shortfall_quantity, safety_shortfall
                    ),
                    recommended_action=res.recommended_action,
                )
            )

        return StockoutRisksResponseOut(
            warehouse_id=warehouse_id,
            checked_sku_count=len(items),
            at_risk_count=at_risk_count,
            items=items,
        )
