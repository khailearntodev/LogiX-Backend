from __future__ import annotations

from datetime import date

from pydantic import BaseModel, Field


class DemandObservationIn(BaseModel):
    demand_date: date
    fulfilled_quantity: float = Field(ge=0.0)
