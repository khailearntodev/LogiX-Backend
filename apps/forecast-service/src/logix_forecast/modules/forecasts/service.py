from __future__ import annotations

import uuid
from uuid import UUID

from logix_forecast.engine.pipeline import run_series_forecast_pipeline
from logix_forecast.engine.schemas import DemandObservationIn
from logix_forecast.modules.forecasts.schemas import (
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
        observations = (
            request.observations
            if request.observations is not None
            else (db_observations or [])
        )

        warehouse_name = request.warehouse_name
        sku_code = request.sku_code
        product_name = request.product_name
        available_stock = request.available_stock

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

        if pipeline_res.status == "INSUFFICIENT_DATA":
            shortfall = 0.0
            stockout_risk = False
            recommended_action = (
                "Insufficient historical demand data in database to compute forecast."
            )
        else:
            shortfall = max(0.0, round(total_pred - available_stock, 3))
            stockout_risk = shortfall > 0.0
            if stockout_risk:
                recommended_action = (
                    f"Stockout risk detected: {request.horizon_days}-day forecast requires {total_pred:.1f} units "
                    f"(upper bound {total_upper:.1f}), exceeding available stock ({available_stock:.1f}). "
                    f"Advisory: replenish at least {shortfall:.1f} units."
                )
            else:
                recommended_action = (
                    f"Stock level is sufficient: available stock ({available_stock:.1f}) "
                    f"covers the {request.horizon_days}-day predicted demand ({total_pred:.1f} units)."
                )

        return ForecastRunOut(
            forecast_run_id=run_id or uuid.uuid4(),
            forecast_series_id=uuid.uuid4(),
            warehouse_id=request.warehouse_id,
            warehouse_name=warehouse_name,
            product_id=request.product_id,
            sku_code=sku_code,
            product_name=product_name,
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
            available_stock=available_stock,
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

    @staticmethod
    def _to_stockout_risk_item(res: ForecastRunOut) -> tuple[StockoutRiskItemOut, bool]:
        safety_shortfall = max(
            0.0, round(res.total_upper_bound_7d - res.available_stock, 3)
        )
        if res.stockout_risk:
            risk_level = "HIGH"
            is_at_risk = True
        elif safety_shortfall > 0.0:
            risk_level = "MEDIUM"
            is_at_risk = True
        else:
            risk_level = "LOW"
            is_at_risk = False

        item = StockoutRiskItemOut(
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
            recommended_replenishment=max(res.shortfall_quantity, safety_shortfall),
            recommended_action=res.recommended_action,
        )
        return item, is_at_risk

    def evaluate_stockout_risks(
        self,
        *,
        warehouse_id: UUID,
        horizon_days: int = 7,
        db_series_by_product: dict[UUID, list[DemandObservationIn]] | None = None,
    ) -> StockoutRisksResponseOut:
        if not db_series_by_product:
            return StockoutRisksResponseOut(
                warehouse_id=warehouse_id,
                checked_sku_count=0,
                at_risk_count=0,
                items=[],
            )

        items: list[StockoutRiskItemOut] = []
        at_risk_count = 0

        for product_id, observations in db_series_by_product.items():
            req = ForecastRunRequest(
                warehouse_id=warehouse_id,
                product_id=product_id,
                horizon_days=horizon_days,
                observations=observations,
            )
            res = self.compute_forecast(req, db_observations=observations)
            item, is_at_risk = self._to_stockout_risk_item(res)
            if is_at_risk:
                at_risk_count += 1
            items.append(item)

        priority = {"HIGH": 0, "MEDIUM": 1, "LOW": 2}
        items.sort(
            key=lambda it: (
                priority.get(it.risk_level, 3),
                -it.recommended_replenishment,
                it.sku_code,
            )
        )

        return StockoutRisksResponseOut(
            warehouse_id=warehouse_id,
            checked_sku_count=len(items),
            at_risk_count=at_risk_count,
            items=items,
        )
