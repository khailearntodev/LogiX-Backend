from __future__ import annotations

from datetime import date

from logix_forecast.engine.baselines import (
    moving_average_7_forecast,
    naive_forecast,
    seasonal_naive_7_forecast,
)
from logix_forecast.engine.preprocessor import fill_missing_dates
from logix_forecast.engine.schemas import DemandObservationIn


def test_preprocessor_imputes_missing_dates_and_clamps_negatives() -> None:
    obs = [
        DemandObservationIn(demand_date=date(2026, 10, 1), fulfilled_quantity=10.0),
        DemandObservationIn(demand_date=date(2026, 10, 1), fulfilled_quantity=5.0),
        DemandObservationIn(demand_date=date(2026, 10, 4), fulfilled_quantity=20.0),
    ]
    series = fill_missing_dates(obs)

    assert series.total_days == 4
    assert series.dates == [
        date(2026, 10, 1),
        date(2026, 10, 2),
        date(2026, 10, 3),
        date(2026, 10, 4),
    ]
    assert series.values == [15.0, 0.0, 0.0, 20.0]
    assert series.nonzero_count == 2
    assert series.zero_ratio == 0.5


def test_baselines_naive_ma7_and_seasonal_naive() -> None:
    history = [10.0, 20.0, 30.0, 40.0, 50.0, 60.0, 70.0]
    naive = naive_forecast(history, horizon=7)
    ma7 = moving_average_7_forecast(history, horizon=7)
    snaive = seasonal_naive_7_forecast(history, horizon=7)

    assert naive == [70.0] * 7
    assert ma7 == [40.0] * 7
    assert snaive == [10.0, 20.0, 30.0, 40.0, 50.0, 60.0, 70.0]
