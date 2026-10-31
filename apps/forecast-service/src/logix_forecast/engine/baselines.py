from __future__ import annotations

import numpy as np


def naive_forecast(history: list[float], horizon: int = 7) -> list[float]:
    """
    Naive Forecaster: y_{t+h} = y_t (repeats the last observed value).
    """
    if horizon <= 0:
        return []
    if not history:
        return [0.0] * horizon
    last_val = max(0.0, round(float(history[-1]), 3))
    return [last_val] * horizon


def moving_average_7_forecast(
    history: list[float], horizon: int = 7, window: int = 7
) -> list[float]:
    """
    Moving Average Forecaster (MA-7): y_{t+h} = (1/W) * sum_{i=0..W-1} y_{t-i}.
    """
    if horizon <= 0:
        return []
    if not history:
        return [0.0] * horizon
    tail = history[-window:] if len(history) >= window else history
    avg_val = max(0.0, round(float(np.mean(tail)), 3))
    return [avg_val] * horizon


def seasonal_naive_7_forecast(
    history: list[float], horizon: int = 7, season_length: int = 7
) -> list[float]:
    """
    Seasonal Naive Forecaster (period = 7 days): y_{t+h} = y_{t+h-7}.
    Repeats the last 7-day cycle. Falls back to naive_forecast if history < season_length.
    """
    if horizon <= 0:
        return []
    if len(history) < season_length:
        return naive_forecast(history, horizon=horizon)

    last_season = history[-season_length:]
    predictions: list[float] = []
    for h in range(horizon):
        val = max(0.0, round(float(last_season[h % season_length]), 3))
        predictions.append(val)
    return predictions
