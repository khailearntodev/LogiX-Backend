"""Tools backed by forecast-service for SKU-warehouse demand forecasting."""

from __future__ import annotations

from datetime import date
from uuid import UUID

from pydantic import BaseModel, Field

from logix_agent.modules.registry import (
    RiskLevel,
    ToolContext,
    ToolRegistry,
    ToolSpec,
)
from logix_agent.modules.tools.catalog._base import View
from logix_agent.modules.tools.http_client import ServiceClient

READ_FORECAST = "forecast:read"
RUN_FORECAST = "forecast:run"


# ---------------------------------------------------------------------------
# Output / Input View Models
# ---------------------------------------------------------------------------


class DailyForecastPointView(View):
    forecast_date: date
    predicted_quantity: float
    lower_bound: float
    upper_bound: float
    trend_component: float = 0.0
    weekly_component: float = 0.0


class MethodMetricsView(View):
    method_name: str
    rmse: float
    mae: float
    mape: float | None = None
    mape_zero_policy: str = "FILTER_POSITIVE"
    evaluated_days: int = 7


class DemandForecastOut(View):
    forecast_run_id: UUID
    forecast_series_id: UUID
    warehouse_id: UUID
    warehouse_name: str
    product_id: UUID
    sku_code: str
    product_name: str
    status: str
    model_name: str
    used_fallback: bool
    fallback_reason: str | None = None
    confidence_level: float
    observation_count: int
    training_start_date: date
    training_end_date: date
    horizon_days: int
    dataset_hash: str
    total_predicted_7d: float
    total_upper_bound_7d: float
    available_stock: float
    stockout_risk: bool
    shortfall_quantity: float
    recommended_action: str
    forecast_points: list[DailyForecastPointView]
    metrics: list[MethodMetricsView]


class StockoutRiskItemView(View):
    warehouse_id: UUID
    warehouse_name: str
    product_id: UUID
    sku_code: str
    product_name: str
    horizon_days: int
    total_predicted_demand: float
    total_upper_bound_demand: float
    available_stock: float
    shortfall_quantity: float
    risk_level: str
    recommended_replenishment: float
    recommended_action: str


class StockoutRisksOut(View):
    warehouse_id: UUID
    checked_sku_count: int
    at_risk_count: int
    items: list[StockoutRiskItemView]


class GetSkuDemandForecastIn(BaseModel):
    warehouse_id: UUID | None = Field(
        None,
        description="UUID of the target warehouse. Omit to use the default primary warehouse.",
    )
    product_id: UUID | None = Field(
        None,
        description="UUID of the target product (SKU). Omit to use the default sample SKU.",
    )
    horizon_days: int = Field(
        7,
        ge=1,
        le=30,
        description="Forecast horizon in days (default: 7).",
    )
    available_stock: float = Field(
        280.0,
        ge=0.0,
        description="Current available inventory stock used for stockout risk assessment.",
    )


class TriggerDemandForecastIn(BaseModel):
    warehouse_id: UUID | None = Field(
        None,
        description="UUID of the target warehouse. Omit to use the default primary warehouse.",
    )
    product_id: UUID | None = Field(
        None,
        description="UUID of the target product (SKU). Omit to use the default sample SKU.",
    )
    sku_code: str | None = Field(
        None,
        description="SKU code identifier (e.g., SKU-FMCG-001).",
    )
    product_name: str | None = Field(
        None,
        description="Display name of the product.",
    )
    horizon_days: int = Field(
        7,
        ge=1,
        le=30,
        description="Forecast horizon in days (default: 7).",
    )
    available_stock: float = Field(
        280.0,
        ge=0.0,
        description="Current available inventory stock used for stockout risk assessment.",
    )


class CheckStockoutRiskIn(BaseModel):
    warehouse_id: UUID | None = Field(
        None,
        description="UUID of the warehouse to evaluate for stockout risks.",
    )
    horizon_days: int = Field(
        7,
        ge=1,
        le=30,
        description="Forecast horizon in days (default: 7).",
    )


# ---------------------------------------------------------------------------
# Tool Registration
# ---------------------------------------------------------------------------


def register(registry: ToolRegistry, client: ServiceClient) -> None:
    async def handle_get_sku_demand_forecast(ctx: ToolContext, args: BaseModel) -> BaseModel:
        assert isinstance(args, GetSkuDemandForecastIn)
        params = args.model_dump(mode="json", exclude_none=True)
        raw = await client.request(
            "forecast",
            "GET",
            "/api/v1/forecast/results",
            ctx,
            params=params or None,
        )
        return DemandForecastOut.model_validate(raw)

    registry.register(
        ToolSpec(
            name="get_sku_demand_forecast",
            description=(
                "Retrieve the 7-day daily demand forecast for a SKU at a warehouse using Meta Prophet, "
                "including 80% confidence intervals (lower_bound to upper_bound), backtesting metrics "
                "(RMSE, MAE, MAPE vs Naive and Moving Average 7 baselines), and advisory replenishment recommendations."
            ),
            input_model=GetSkuDemandForecastIn,
            output_model=DemandForecastOut,
            handler=handle_get_sku_demand_forecast,
            required_permission=READ_FORECAST,
            risk_level=RiskLevel.READ,
            target_service="forecast",
        )
    )

    async def handle_trigger_demand_forecast(ctx: ToolContext, args: BaseModel) -> BaseModel:
        assert isinstance(args, TriggerDemandForecastIn)
        raw = await client.request(
            "forecast",
            "POST",
            "/api/v1/forecast/runs",
            ctx,
            json=args.model_dump(mode="json", exclude_none=True),
        )
        return DemandForecastOut.model_validate(raw)

    registry.register(
        ToolSpec(
            name="trigger_demand_forecast",
            description=(
                "Trigger an on-demand 7-day demand forecast computation run for a SKU-warehouse pair "
                "using Meta Prophet (with automatic Moving Average fallback for sparse data) and return "
                "the predicted quantities, confidence intervals, and accuracy metrics."
            ),
            input_model=TriggerDemandForecastIn,
            output_model=DemandForecastOut,
            handler=handle_trigger_demand_forecast,
            required_permission=RUN_FORECAST,
            risk_level=RiskLevel.READ,
            target_service="forecast",
        )
    )

    async def handle_check_stockout_risk(ctx: ToolContext, args: BaseModel) -> BaseModel:
        assert isinstance(args, CheckStockoutRiskIn)
        params = args.model_dump(mode="json", exclude_none=True)
        raw = await client.request(
            "forecast",
            "GET",
            "/api/v1/forecast/stockout-risks",
            ctx,
            params=params or None,
        )
        return StockoutRisksOut.model_validate(raw)

    registry.register(
        ToolSpec(
            name="check_stockout_risk",
            description=(
                "Scan warehouse SKUs against their 7-day upper-bound forecasted demand to detect "
                "potential stockout risks (CRITICAL, WARNING, SAFE) and provide advisory replenishment quantities."
            ),
            input_model=CheckStockoutRiskIn,
            output_model=StockoutRisksOut,
            handler=handle_check_stockout_risk,
            required_permission=READ_FORECAST,
            risk_level=RiskLevel.READ,
            target_service="forecast",
        )
    )
