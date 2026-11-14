from __future__ import annotations

import uuid
from datetime import date
from uuid import UUID

from pydantic import BaseModel, Field

from logix_forecast.engine.schemas import (
    DailyForecastPointOut,
    DemandObservationIn,
    MethodMetricsOut,
)

class ForecastRunRequest(BaseModel):
    tenant_id: UUID | None = None
    warehouse_id: UUID
    product_id: UUID
    warehouse_name: str = ""
    sku_code: str = ""
    product_name: str = ""
    horizon_days: int = Field(default=7, ge=1, le=30)
    available_stock: float = Field(default=0.0, ge=0.0)
    observations: list[DemandObservationIn] | None = None
    idempotency_key: str | None = None


class ForecastRunOut(BaseModel):
    forecast_run_id: UUID = Field(default_factory=uuid.uuid4)
    forecast_series_id: UUID = Field(default_factory=uuid.uuid4)
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
    forecast_points: list[DailyForecastPointOut]
    metrics: list[MethodMetricsOut]


class ForecastMetricsComparisonOut(BaseModel):
    forecast_run_id: UUID
    warehouse_id: UUID
    product_id: UUID
    sku_code: str
    selected_model: str
    used_fallback: bool
    prophet_rmse: float | None = None
    baseline_ma7_rmse: float | None = None
    baseline_naive_rmse: float | None = None
    improvement_vs_ma7_percent: float = 0.0
    metrics: list[MethodMetricsOut]
    analysis_summary: str


class StockoutRiskItemOut(BaseModel):
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


class StockoutRisksResponseOut(BaseModel):
    warehouse_id: UUID
    checked_sku_count: int
    at_risk_count: int
    items: list[StockoutRiskItemOut]
