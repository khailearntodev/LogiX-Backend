from __future__ import annotations

from datetime import date
from typing import Literal

from pydantic import BaseModel, Field


class DemandObservationIn(BaseModel):
    demand_date: date
    fulfilled_quantity: float = Field(ge=0.0)


class MethodMetricsOut(BaseModel):
    method_name: str
    method_type: Literal["MODEL", "BASELINE"]
    rmse: float = Field(ge=0.0)
    mape: float | None = Field(default=None, ge=0.0)
    mae: float = Field(ge=0.0)
    zero_actual_policy: str = "FILTER_POSITIVE"
    eligible_point_count: int = Field(ge=0)
    total_point_count: int = Field(ge=0)
    evaluation_start_date: date
    evaluation_end_date: date


class DailyForecastPointOut(BaseModel):
    forecast_date: date
    predicted_quantity: float = Field(ge=0.0)
    lower_bound: float = Field(ge=0.0)
    upper_bound: float = Field(ge=0.0)
    baseline_naive: float = Field(ge=0.0)
    baseline_moving_average_7: float = Field(ge=0.0)
    baseline_seasonal_naive_7: float = Field(ge=0.0)
    confidence_level: float = Field(gt=0.0, lt=1.0)
    model_metadata: dict[str, object] = Field(default_factory=dict)


class SeriesPipelineResult(BaseModel):
    status: Literal["SUCCEEDED", "INSUFFICIENT_DATA"]
    observation_count: int = Field(ge=0)
    raw_observation_count: int = Field(ge=0)
    training_start_date: date
    training_end_date: date
    horizon_days: int = Field(gt=0)
    confidence_level: float = Field(gt=0.0, lt=1.0)
    used_fallback: bool
    fallback_reason: str | None = None
    model_name: str
    dataset_hash: str
    forecast_points: list[DailyForecastPointOut]
    metrics: list[MethodMetricsOut]
