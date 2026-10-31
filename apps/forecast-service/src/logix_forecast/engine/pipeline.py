from __future__ import annotations

import hashlib
import logging
from collections.abc import Sequence
from datetime import timedelta

import numpy as np

from logix_forecast.engine.baselines import (
    moving_average_7_forecast,
    naive_forecast,
    seasonal_naive_7_forecast,
)
from logix_forecast.engine.fallback import check_fallback_condition
from logix_forecast.engine.metrics import evaluate_method_metrics
from logix_forecast.engine.preprocessor import PreprocessedSeries, fill_missing_dates
from logix_forecast.engine.prophet_model import ProphetForecaster
from logix_forecast.engine.schemas import (
    DailyForecastPointOut,
    DemandObservationIn,
    MethodMetricsOut,
    SeriesPipelineResult,
)

logger = logging.getLogger(__name__)


def compute_series_dataset_hash(series: PreprocessedSeries) -> str:
    """
    Computes a deterministic SHA-256 hash over the normalized daily series
    for auditability and reproducibility.
    """
    if series.raw_observation_count == 0:
        return hashlib.sha256(b"empty_series").hexdigest()
    payload = "|".join(
        f"{d.isoformat()}:{v:.3f}"
        for d, v in zip(series.dates, series.values, strict=True)
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _build_fallback_points(
    series: PreprocessedSeries,
    horizon: int,
    confidence_level: float,
    fallback_reason: str,
    ma7_preds: list[float],
    naive_preds: list[float],
    snaive_preds: list[float],
) -> list[DailyForecastPointOut]:
    tail = series.values[-7:] if series.values else [0.0]
    std_val = float(np.std(tail)) if len(tail) > 1 else 0.0
    points: list[DailyForecastPointOut] = []

    for step in range(horizon):
        f_date = series.end_date + timedelta(days=step + 1)
        pred = ma7_preds[step]
        margin = max(std_val, round(0.20 * pred, 3))
        low = max(0.0, round(pred - margin, 3))
        high = max(pred, round(pred + margin, 3))

        points.append(
            DailyForecastPointOut(
                forecast_date=f_date,
                predicted_quantity=pred,
                lower_bound=low,
                upper_bound=high,
                baseline_naive=naive_preds[step],
                baseline_moving_average_7=ma7_preds[step],
                baseline_seasonal_naive_7=snaive_preds[step],
                confidence_level=confidence_level,
                model_metadata={
                    "engine": "Moving Average 7 (Fallback)",
                    "used_fallback": True,
                    "fallback_reason": fallback_reason,
                },
            )
        )
    return points


def _evaluate_backtest_metrics(
    series: PreprocessedSeries,
    *,
    horizon: int,
    min_observations: int,
    max_zero_ratio: float,
    interval_width: float,
    used_fallback: bool,
) -> list[MethodMetricsOut]:
    """
    Evaluates forecast error metrics (RMSE, MAE, MAPE) on a holdout backtest window
    at the tail of the historical series. Both the primary model and baselines are
    trained on the same `train_values` split and scored against `eval_actuals`.
    """
    if series.raw_observation_count == 0 or series.total_days < 3:
        return []

    eval_len = (
        horizon
        if series.total_days >= min_observations + horizon
        else min(horizon, max(1, series.total_days // 3))
    )
    train_dates = series.dates[:-eval_len]
    train_values = series.values[:-eval_len]
    eval_dates = series.dates[-eval_len:]
    eval_actuals = series.values[-eval_len:]
    eval_start = eval_dates[0]
    eval_end = eval_dates[-1]

    metrics: list[MethodMetricsOut] = []

    # 1. Evaluate Meta Prophet on the holdout split when history is sufficient
    if not used_fallback and len(train_dates) >= min_observations:
        train_nonzero = sum(1 for v in train_values if v > 0.0)
        train_zero_ratio = (len(train_values) - train_nonzero) / len(train_values)
        if train_nonzero >= 4 and train_zero_ratio <= max_zero_ratio:
            try:
                forecaster = ProphetForecaster(
                    interval_width=interval_width,
                    weekly_seasonality=True,
                )
                bt_res = forecaster.fit_predict(
                    train_dates, train_values, horizon=eval_len
                )
                prophet_bt_preds = [pt.predicted for pt in bt_res.future_points]
                metrics.append(
                    evaluate_method_metrics(
                        y_true=eval_actuals,
                        y_pred=prophet_bt_preds,
                        method_name="Meta Prophet",
                        method_type="MODEL",
                        evaluation_start_date=eval_start,
                        evaluation_end_date=eval_end,
                    )
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "Backtest Prophet failed (%s); skipping Prophet metric.", exc
                )

    # 2. Always evaluate baseline forecasters on the exact same holdout window
    ma7_bt_preds = moving_average_7_forecast(train_values, horizon=eval_len)
    metrics.append(
        evaluate_method_metrics(
            y_true=eval_actuals,
            y_pred=ma7_bt_preds,
            method_name="Moving Average 7",
            method_type="BASELINE",
            evaluation_start_date=eval_start,
            evaluation_end_date=eval_end,
        )
    )

    naive_bt_preds = naive_forecast(train_values, horizon=eval_len)
    metrics.append(
        evaluate_method_metrics(
            y_true=eval_actuals,
            y_pred=naive_bt_preds,
            method_name="Naive",
            method_type="BASELINE",
            evaluation_start_date=eval_start,
            evaluation_end_date=eval_end,
        )
    )

    snaive_bt_preds = seasonal_naive_7_forecast(train_values, horizon=eval_len)
    metrics.append(
        evaluate_method_metrics(
            y_true=eval_actuals,
            y_pred=snaive_bt_preds,
            method_name="Seasonal Naive 7",
            method_type="BASELINE",
            evaluation_start_date=eval_start,
            evaluation_end_date=eval_end,
        )
    )

    return metrics


def run_series_forecast_pipeline(
    observations: Sequence[DemandObservationIn],
    *,
    horizon: int = 7,
    min_observations: int = 14,
    max_zero_ratio: float = 0.85,
    interval_width: float = 0.80,
) -> SeriesPipelineResult:
    """
    Orchestrates the end-to-end forecasting pipeline for a single (Warehouse, SKU) series:
        1. Calendar imputation and zero-filling (`fill_missing_dates`).
        2. Baseline forecast computation (Naive, MA-7, Seasonal Naive 7).
        3. Sparsity and history length validation (`check_fallback_condition`).
        4. Meta Prophet fitting & prediction (with automatic fallback to MA-7).
        5. Holdout backtest evaluation for RMSE, MAE, and MAPE comparison.
    """
    if horizon <= 0:
        raise ValueError("horizon must be greater than 0")

    series = fill_missing_dates(list(observations))
    dataset_hash = compute_series_dataset_hash(series)

    naive_preds = naive_forecast(series.values, horizon=horizon)
    ma7_preds = moving_average_7_forecast(series.values, horizon=horizon)
    snaive_preds = seasonal_naive_7_forecast(series.values, horizon=horizon)

    if series.raw_observation_count == 0:
        reason = "NO_OBSERVATIONS"
        points = _build_fallback_points(
            series=series,
            horizon=horizon,
            confidence_level=0.50,
            fallback_reason=reason,
            ma7_preds=ma7_preds,
            naive_preds=naive_preds,
            snaive_preds=snaive_preds,
        )
        return SeriesPipelineResult(
            status="INSUFFICIENT_DATA",
            observation_count=0,
            raw_observation_count=0,
            training_start_date=series.start_date,
            training_end_date=series.end_date,
            horizon_days=horizon,
            confidence_level=0.50,
            used_fallback=True,
            fallback_reason=reason,
            model_name="Moving Average 7 (Fallback)",
            dataset_hash=dataset_hash,
            forecast_points=points,
            metrics=[],
        )

    decision = check_fallback_condition(
        series,
        min_observations=min_observations,
        max_zero_ratio=max_zero_ratio,
        default_confidence=interval_width,
    )

    used_fallback = decision.should_fallback
    fallback_reason = decision.reason
    confidence_level = decision.confidence_level
    model_name = "Meta Prophet"
    forecast_points: list[DailyForecastPointOut] = []

    if not used_fallback:
        try:
            forecaster = ProphetForecaster(
                interval_width=interval_width,
                weekly_seasonality=True,
            )
            prophet_res = forecaster.fit_predict(
                series.dates,
                series.values,
                horizon=horizon,
            )
            for idx, pt in enumerate(prophet_res.future_points):
                forecast_points.append(
                    DailyForecastPointOut(
                        forecast_date=pt.forecast_date,
                        predicted_quantity=pt.predicted,
                        lower_bound=pt.lower_bound,
                        upper_bound=pt.upper_bound,
                        baseline_naive=naive_preds[idx],
                        baseline_moving_average_7=ma7_preds[idx],
                        baseline_seasonal_naive_7=snaive_preds[idx],
                        confidence_level=confidence_level,
                        model_metadata={
                            "engine": prophet_res.model_engine,
                            "trend": pt.trend,
                            "weekly_seasonal": pt.weekly_seasonal,
                            "used_fallback": False,
                        },
                    )
                )
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "Prophet failed during pipeline execution (%s); degrading to MA-7 fallback.",
                exc,
            )
            used_fallback = True
            fallback_reason = f"PROPHET_EXECUTION_ERROR ({type(exc).__name__})"
            confidence_level = 0.50

    if used_fallback:
        model_name = "Moving Average 7 (Fallback)"
        forecast_points = _build_fallback_points(
            series=series,
            horizon=horizon,
            confidence_level=confidence_level,
            fallback_reason=fallback_reason or "FALLBACK_TRIGGERED",
            ma7_preds=ma7_preds,
            naive_preds=naive_preds,
            snaive_preds=snaive_preds,
        )

    metrics = _evaluate_backtest_metrics(
        series,
        horizon=horizon,
        min_observations=min_observations,
        max_zero_ratio=max_zero_ratio,
        interval_width=interval_width,
        used_fallback=used_fallback,
    )

    return SeriesPipelineResult(
        status="SUCCEEDED",
        observation_count=series.total_days,
        raw_observation_count=series.raw_observation_count,
        training_start_date=series.start_date,
        training_end_date=series.end_date,
        horizon_days=horizon,
        confidence_level=confidence_level,
        used_fallback=used_fallback,
        fallback_reason=fallback_reason,
        model_name=model_name,
        dataset_hash=dataset_hash,
        forecast_points=forecast_points,
        metrics=metrics,
    )
