from __future__ import annotations

import logging
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date

import pandas as pd
from prophet import Prophet

# Suppress verbose CmdStan and Prophet info logs
logging.getLogger("cmdstanpy").setLevel(logging.WARNING)
logging.getLogger("prophet").setLevel(logging.WARNING)


@dataclass(frozen=True)
class ProphetForecastPoint:
    """Single future day forecast point produced by Meta Prophet."""

    forecast_date: date
    predicted: float
    lower_bound: float
    upper_bound: float
    trend: float
    weekly_seasonal: float


@dataclass(frozen=True)
class ProphetFitResult:
    """Complete forecast output from the official Meta Prophet engine."""

    future_points: list[ProphetForecastPoint]
    fitted_values: list[float]
    model_engine: str = "Meta Prophet (Official)"


class ProphetForecaster:
    """
    Demand forecaster powered by the official Meta Prophet library (`prophet.Prophet`).

    Workflow:
        1. Converts the historical series (dates, values) into a [ds, y] DataFrame.
        2. Configures Prophet with weekly seasonality and confidence interval width.
        3. Fits the model and predicts over the requested future horizon.
        4. Extracts point forecasts and confidence bounds, clamping negative values
           to 0.0 to enforce non-negative logistics demand constraints.
    """

    def __init__(
        self,
        *,
        interval_width: float = 0.80,
        weekly_seasonality: bool = True,
        yearly_seasonality: bool = False,
        fourier_order: int = 3,
        changepoint_prior_scale: float = 0.05,
    ) -> None:
        self.interval_width = interval_width
        self.weekly_seasonality = weekly_seasonality
        self.yearly_seasonality = yearly_seasonality
        self.fourier_order = fourier_order
        self.changepoint_prior_scale = changepoint_prior_scale

    def fit_predict(
        self,
        dates: Sequence[date],
        values: Sequence[float],
        horizon: int = 7,
    ) -> ProphetFitResult:
        if not dates or not values or len(dates) != len(values):
            raise ValueError(
                "dates and values must be non-empty and have matching lengths"
            )

        # 1. Prepare canonical Prophet training DataFrame with columns [ds, y]
        df = pd.DataFrame(
            {
                "ds": pd.to_datetime(list(dates)),
                "y": [float(v) for v in values],
            }
        )

        # 2. Initialize official Meta Prophet model
        model = Prophet(
            interval_width=self.interval_width,
            weekly_seasonality=False,
            yearly_seasonality=self.yearly_seasonality,
            daily_seasonality=False,
            changepoint_prior_scale=self.changepoint_prior_scale,
        )
        if self.weekly_seasonality:
            model.add_seasonality(
                name="weekly",
                period=7,
                fourier_order=self.fourier_order,
            )

        # 3. Fit model on historical observations
        model.fit(df)

        # 4. Generate future calendar dates and run prediction
        future_df = model.make_future_dataframe(periods=horizon, freq="D")
        forecast_df = model.predict(future_df)

        # 5. Extract in-sample fitted values over the historical window
        n_hist = len(dates)
        fitted_values = [
            max(0.0, round(float(v), 3)) for v in forecast_df["yhat"].iloc[:n_hist]
        ]

        # 6. Extract future horizon forecast points and clamp non-negative bounds
        future_points: list[ProphetForecastPoint] = []
        for idx in range(n_hist, n_hist + horizon):
            row = forecast_df.iloc[idx]
            pred = max(0.0, round(float(row["yhat"]), 3))
            low = max(0.0, round(float(row["yhat_lower"]), 3))
            high = max(pred, round(float(row["yhat_upper"]), 3))
            trend_val = round(float(row.get("trend", pred)), 3)
            weekly_val = round(float(row.get("weekly", 0.0)), 3)

            future_points.append(
                ProphetForecastPoint(
                    forecast_date=row["ds"].date(),
                    predicted=pred,
                    lower_bound=min(low, pred),
                    upper_bound=max(high, pred),
                    trend=trend_val,
                    weekly_seasonal=weekly_val,
                )
            )

        return ProphetFitResult(
            future_points=future_points,
            fitted_values=fitted_values,
            model_engine="Meta Prophet (Official)",
        )
