from __future__ import annotations

from datetime import date, timedelta
from uuid import UUID

from logix_forecast.engine.schemas import DemandObservationIn

SAMPLE_SKUS: list[dict[str, object]] = [
    {
        "product_id": UUID("00000000-0000-0000-0000-000000000201"),
        "sku_code": "SKU-FMCG-001",
        "product_name": "Thùng Nước Giải Khát 24 Lon",
        "available_stock": 280.0,
        "base_demand": 42.0,
        "daily_trend": 0.35,
    },
    {
        "product_id": UUID("00000000-0000-0000-0000-000000000202"),
        "sku_code": "SKU-PACK-002",
        "product_name": "Thùng Carton Đóng Hàng 5 Lớp",
        "available_stock": 600.0,
        "base_demand": 50.0,
        "daily_trend": 0.20,
    },
]


def build_default_observations(
    *,
    days: int = 56,
    base_demand: float = 42.0,
    daily_trend: float = 0.35,
    end_date: date | None = None,
) -> list[DemandObservationIn]:
    """
    Generates a deterministic 56-day daily demand series with realistic B2B
    weekly seasonality and trend when no database observations are provided.
    """
    weekly_factors = [0.80, 0.90, 0.95, 1.05, 1.20, 1.35, 0.75]
    anchor_end = end_date or date(2026, 10, 30)
    start_date = anchor_end - timedelta(days=days - 1)

    observations: list[DemandObservationIn] = []
    for idx in range(days):
        curr_date = start_date + timedelta(days=idx)
        factor = weekly_factors[curr_date.weekday()]
        qty = round((base_demand + daily_trend * idx) * factor, 2)
        observations.append(
            DemandObservationIn(
                demand_date=curr_date,
                fulfilled_quantity=qty,
            )
        )
    return observations
