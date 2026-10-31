from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Literal

import numpy as np

from logix_forecast.engine.schemas import MethodMetricsOut

ZERO_ACTUAL_POLICY_FILTER = "FILTER_POSITIVE"


@dataclass(frozen=True)
class MapeCalculation:
    mape: float | None
    eligible_point_count: int
    total_point_count: int
    zero_actual_policy: str = ZERO_ACTUAL_POLICY_FILTER


def compute_rmse(y_true: list[float], y_pred: list[float]) -> float:
    """
    Root Mean Squared Error: RMSE = sqrt((1/n) * sum((y_i - y_hat_i)^2)).
    Safe against zero actuals.
    """
    if not y_true or not y_pred or len(y_true) != len(y_pred):
        return 0.0
    arr_true = np.asarray(y_true, dtype=np.float64)
    arr_pred = np.asarray(y_pred, dtype=np.float64)
    rmse = float(np.sqrt(np.mean(np.square(arr_true - arr_pred))))
    return round(max(0.0, rmse), 4)


def compute_mae(y_true: list[float], y_pred: list[float]) -> float:
    """
    Mean Absolute Error: MAE = (1/n) * sum(|y_i - y_hat_i|).
    """
    if not y_true or not y_pred or len(y_true) != len(y_pred):
        return 0.0
    arr_true = np.asarray(y_true, dtype=np.float64)
    arr_pred = np.asarray(y_pred, dtype=np.float64)
    mae = float(np.mean(np.abs(arr_true - arr_pred)))
    return round(max(0.0, mae), 4)


def compute_mape_with_policy(
    y_true: list[float],
    y_pred: list[float],
    policy: str = ZERO_ACTUAL_POLICY_FILTER,
) -> MapeCalculation:
    """
    Mean Absolute Percentage Error (MAPE) with explicit Zero-Actual Policy:
    Filters points where y_true > 0 to avoid division by zero, and records
    eligible_point_count / total_point_count.
    """
    total = min(len(y_true), len(y_pred))
    if total == 0:
        return MapeCalculation(
            mape=None,
            eligible_point_count=0,
            total_point_count=0,
            zero_actual_policy=policy,
        )

    ape_values: list[float] = []
    for actual, pred in zip(y_true[:total], y_pred[:total], strict=False):
        if actual > 0.0:
            ape_values.append(abs(actual - pred) / actual * 100.0)

    eligible = len(ape_values)
    if eligible == 0:
        return MapeCalculation(
            mape=None,
            eligible_point_count=0,
            total_point_count=total,
            zero_actual_policy=policy,
        )

    mape_val = round(float(np.mean(ape_values)), 4)
    return MapeCalculation(
        mape=mape_val,
        eligible_point_count=eligible,
        total_point_count=total,
        zero_actual_policy=policy,
    )


def evaluate_method_metrics(
    *,
    y_true: list[float],
    y_pred: list[float],
    method_name: str,
    method_type: Literal["MODEL", "BASELINE"],
    evaluation_start_date: date,
    evaluation_end_date: date,
) -> MethodMetricsOut:
    rmse = compute_rmse(y_true, y_pred)
    mae = compute_mae(y_true, y_pred)
    mape_res = compute_mape_with_policy(y_true, y_pred)
    return MethodMetricsOut(
        method_name=method_name,
        method_type=method_type,
        rmse=rmse,
        mape=mape_res.mape,
        mae=mae,
        zero_actual_policy=mape_res.zero_actual_policy,
        eligible_point_count=mape_res.eligible_point_count,
        total_point_count=mape_res.total_point_count,
        evaluation_start_date=evaluation_start_date,
        evaluation_end_date=evaluation_end_date,
    )
