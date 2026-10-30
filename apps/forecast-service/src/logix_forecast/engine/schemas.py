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
