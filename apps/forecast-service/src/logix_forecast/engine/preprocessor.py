from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta

from logix_forecast.engine.schemas import DemandObservationIn


@dataclass(frozen=True)
class PreprocessedSeries:
    dates: list[date]
    values: list[float]
    raw_observation_count: int
    total_days: int
    nonzero_count: int
    zero_ratio: float
    start_date: date
    end_date: date


def fill_missing_dates(observations: list[DemandObservationIn]) -> PreprocessedSeries:
    """
    Aggregates observations by date, sorts chronologically, and performs
    calendar imputation (zero-filling) so the daily time series has no gaps.
    Clamps any negative quantities to 0.0.
    """
    if not observations:
        today = date.today()
        return PreprocessedSeries(
            dates=[today],
            values=[0.0],
            raw_observation_count=0,
            total_days=1,
            nonzero_count=0,
            zero_ratio=1.0,
            start_date=today,
            end_date=today,
        )

    daily_totals: dict[date, float] = {}
    for obs in observations:
        qty = max(0.0, float(obs.fulfilled_quantity))
        daily_totals[obs.demand_date] = daily_totals.get(obs.demand_date, 0.0) + qty

    start_date = min(daily_totals.keys())
    end_date = max(daily_totals.keys())
    num_days = (end_date - start_date).days + 1

    dates: list[date] = []
    values: list[float] = []
    for offset in range(num_days):
        current_date = start_date + timedelta(days=offset)
        dates.append(current_date)
        values.append(round(daily_totals.get(current_date, 0.0), 3))

    nonzero_count = sum(1 for v in values if v > 0.0)
    zero_ratio = round((num_days - nonzero_count) / num_days, 4) if num_days > 0 else 1.0

    return PreprocessedSeries(
        dates=dates,
        values=values,
        raw_observation_count=len(observations),
        total_days=num_days,
        nonzero_count=nonzero_count,
        zero_ratio=zero_ratio,
        start_date=start_date,
        end_date=end_date,
    )
