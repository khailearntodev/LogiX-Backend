from __future__ import annotations

from logix_forecast.engine.baselines import (
    moving_average_7_forecast,
    naive_forecast,
    seasonal_naive_7_forecast,
)
from logix_forecast.engine.fallback import FallbackDecision, check_fallback_condition
from logix_forecast.engine.metrics import (
    ZERO_ACTUAL_POLICY_FILTER,
    MapeCalculation,
    compute_mae,
    compute_mape_with_policy,
    compute_rmse,
    evaluate_method_metrics,
)
from logix_forecast.engine.preprocessor import PreprocessedSeries, fill_missing_dates
from logix_forecast.engine.schemas import DemandObservationIn, MethodMetricsOut

__all__ = [
    "DemandObservationIn",
    "FallbackDecision",
    "MapeCalculation",
    "MethodMetricsOut",
    "PreprocessedSeries",
    "ZERO_ACTUAL_POLICY_FILTER",
    "check_fallback_condition",
    "compute_mae",
    "compute_mape_with_policy",
    "compute_rmse",
    "evaluate_method_metrics",
    "fill_missing_dates",
    "moving_average_7_forecast",
    "naive_forecast",
    "seasonal_naive_7_forecast",
]
