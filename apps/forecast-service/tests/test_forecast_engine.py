from __future__ import annotations

from datetime import date, timedelta

from logix_forecast.engine.baselines import (
    moving_average_7_forecast,
    naive_forecast,
    seasonal_naive_7_forecast,
)
from logix_forecast.engine.fallback import check_fallback_condition
from logix_forecast.engine.metrics import (
    ZERO_ACTUAL_POLICY_FILTER,
    compute_mae,
    compute_mape_with_policy,
    compute_rmse,
    evaluate_method_metrics,
)
from logix_forecast.engine.pipeline import run_series_forecast_pipeline
from logix_forecast.engine.preprocessor import fill_missing_dates
from logix_forecast.engine.prophet_model import ProphetForecaster
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


def test_metrics_zero_actual_policy_and_rmse() -> None:
    y_true = [0.0, 10.0, 0.0, 20.0]
    y_pred = [2.0, 12.0, 1.0, 16.0]

    rmse = compute_rmse(y_true, y_pred)
    mae = compute_mae(y_true, y_pred)
    mape_res = compute_mape_with_policy(y_true, y_pred)

    assert rmse == 2.5
    assert mae == 2.25
    assert mape_res.zero_actual_policy == ZERO_ACTUAL_POLICY_FILTER
    assert mape_res.total_point_count == 4
    assert mape_res.eligible_point_count == 2
    assert mape_res.mape == 20.0

    summary = evaluate_method_metrics(
        y_true=y_true,
        y_pred=y_pred,
        method_name="Meta Prophet",
        method_type="MODEL",
        evaluation_start_date=date(2026, 10, 1),
        evaluation_end_date=date(2026, 10, 4),
    )
    assert summary.eligible_point_count == 2
    assert summary.total_point_count == 4
    assert summary.mape == 20.0


def test_metrics_all_zero_actuals_returns_none_mape_without_error() -> None:
    y_true = [0.0, 0.0, 0.0]
    y_pred = [1.0, 2.0, 3.0]

    mape_res = compute_mape_with_policy(y_true, y_pred)
    assert mape_res.mape is None
    assert mape_res.eligible_point_count == 0
    assert mape_res.total_point_count == 3
    assert compute_rmse(y_true, y_pred) > 0.0


def test_fallback_triggers_on_short_history_or_high_sparsity() -> None:
    # Case 1: Only 10 days (< 14 days threshold)
    short_obs = [
        DemandObservationIn(
            demand_date=date(2026, 10, 1) + timedelta(days=i),
            fulfilled_quantity=15.0,
        )
        for i in range(10)
    ]
    short_series = fill_missing_dates(short_obs)
    short_decision = check_fallback_condition(short_series, min_observations=14)
    assert short_decision.should_fallback is True
    assert short_decision.confidence_level == 0.50
    assert (
        short_decision.reason is not None
        and "INSUFFICIENT_HISTORY" in short_decision.reason
    )

    # Case 2: 20 days span, but only 2 non-zero days (90% zeros > 85% threshold)
    sparse_obs = [
        DemandObservationIn(demand_date=date(2026, 10, 1), fulfilled_quantity=5.0),
        DemandObservationIn(demand_date=date(2026, 10, 20), fulfilled_quantity=8.0),
    ]
    sparse_series = fill_missing_dates(sparse_obs)
    sparse_decision = check_fallback_condition(sparse_series, min_observations=14)
    assert sparse_series.total_days == 20
    assert sparse_decision.should_fallback is True
    assert sparse_decision.confidence_level == 0.50
    assert (
        sparse_decision.reason is not None
        and "EXTREME_ZERO_SPARSITY" in sparse_decision.reason
    )

    # Case 3: Healthy 20-day series
    healthy_obs = [
        DemandObservationIn(
            demand_date=date(2026, 10, 1) + timedelta(days=i),
            fulfilled_quantity=20.0 + i,
        )
        for i in range(20)
    ]
    healthy_series = fill_missing_dates(healthy_obs)
    healthy_decision = check_fallback_condition(healthy_series, min_observations=14)
    assert healthy_decision.should_fallback is False
    assert healthy_decision.reason is None
    assert healthy_decision.confidence_level == 0.80


def test_prophet_forecaster_captures_trend_and_weekly_seasonality() -> None:
    # 56 days (8 weeks): 49 days train + 7 days holdout test with trend + weekly pattern
    weekly_factors = [0.75, 0.85, 0.90, 1.00, 1.15, 1.40, 0.95]
    start = date(2026, 9, 1)
    dates = [start + timedelta(days=i) for i in range(56)]
    values = [
        round(
            (40.0 + 0.3 * i) * weekly_factors[(start + timedelta(days=i)).weekday()], 2
        )
        for i in range(56)
    ]

    train_dates, test_dates = dates[:49], dates[49:]
    train_vals, test_actuals = values[:49], values[49:]

    forecaster = ProphetForecaster(interval_width=0.80, weekly_seasonality=True)
    res = forecaster.fit_predict(train_dates, train_vals, horizon=7)

    assert len(res.future_points) == 7
    assert len(res.fitted_values) == 49
    assert [p.forecast_date for p in res.future_points] == test_dates

    for pt in res.future_points:
        assert pt.predicted >= 0.0
        assert pt.lower_bound >= 0.0
        assert pt.lower_bound <= pt.predicted <= pt.upper_bound

    prophet_preds = [p.predicted for p in res.future_points]
    ma7_preds = moving_average_7_forecast(train_vals, horizon=7)

    prophet_rmse = compute_rmse(test_actuals, prophet_preds)
    ma7_rmse = compute_rmse(test_actuals, ma7_preds)
    assert prophet_rmse < ma7_rmse


def test_pipeline_healthy_series_runs_prophet_and_computes_backtest_metrics() -> None:
    weekly_factors = [0.75, 0.85, 0.90, 1.00, 1.15, 1.40, 0.95]
    start = date(2026, 9, 1)
    observations = [
        DemandObservationIn(
            demand_date=start + timedelta(days=i),
            fulfilled_quantity=round(
                (40.0 + 0.3 * i)
                * weekly_factors[(start + timedelta(days=i)).weekday()],
                2,
            ),
        )
        for i in range(56)
    ]

    result = run_series_forecast_pipeline(observations, horizon=7)

    assert result.status == "SUCCEEDED"
    assert result.used_fallback is False
    assert result.fallback_reason is None
    assert result.confidence_level == 0.80
    assert result.model_name == "Meta Prophet"
    assert result.observation_count == 56
    assert len(result.dataset_hash) == 64
    assert len(result.forecast_points) == 7

    for pt in result.forecast_points:
        assert pt.lower_bound <= pt.predicted_quantity <= pt.upper_bound
        assert pt.baseline_moving_average_7 > 0.0
        assert pt.baseline_naive > 0.0

    metrics_by_name = {m.method_name: m for m in result.metrics}
    assert "Meta Prophet" in metrics_by_name
    assert "Moving Average 7" in metrics_by_name
    assert "Naive" in metrics_by_name
    assert "Seasonal Naive 7" in metrics_by_name
    assert (
        metrics_by_name["Meta Prophet"].rmse < metrics_by_name["Moving Average 7"].rmse
    )


def test_pipeline_short_or_empty_series_triggers_fallback_safely() -> None:
    # 1. Short 7-day series (< 14 days threshold)
    short_obs = [
        DemandObservationIn(
            demand_date=date(2026, 10, 1) + timedelta(days=i),
            fulfilled_quantity=10.0 + i,
        )
        for i in range(7)
    ]
    short_res = run_series_forecast_pipeline(short_obs, horizon=7)
    assert short_res.status == "SUCCEEDED"
    assert short_res.used_fallback is True
    assert short_res.confidence_level == 0.50
    assert short_res.model_name == "Moving Average 7 (Fallback)"
    assert len(short_res.forecast_points) == 7
    assert all(pt.predicted_quantity == 13.0 for pt in short_res.forecast_points)
    assert len(short_res.metrics) >= 2

    # 2. Empty observation list
    empty_res = run_series_forecast_pipeline([], horizon=7)
    assert empty_res.status == "INSUFFICIENT_DATA"
    assert empty_res.used_fallback is True
    assert empty_res.observation_count == 0
    assert len(empty_res.forecast_points) == 7
    assert all(pt.predicted_quantity == 0.0 for pt in empty_res.forecast_points)
    assert empty_res.metrics == []
