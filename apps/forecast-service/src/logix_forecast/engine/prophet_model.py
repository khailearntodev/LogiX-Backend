from __future__ import annotations

import logging
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date

import pandas as pd
from prophet import Prophet

# Tắt log chi tiết của CmdStan để tránh làm ngập terminal
logging.getLogger("cmdstanpy").setLevel(logging.WARNING)
logging.getLogger("prophet").setLevel(logging.WARNING)


@dataclass(frozen=True)
class ProphetForecastPoint:
    """Điểm dự báo cho một ngày trong tương lai."""

    forecast_date: date
    predicted: float
    lower_bound: float
    upper_bound: float
    trend: float
    weekly_seasonal: float


@dataclass(frozen=True)
class ProphetFitResult:
    """Kết quả dự báo hoàn chỉnh từ mô hình Meta Prophet."""

    future_points: list[ProphetForecastPoint]
    fitted_values: list[float]
    model_engine: str = "Meta Prophet (Official)"


class ProphetForecaster:
    """
    Bộ dự báo nhu cầu sử dụng hoàn toàn thư viện chính thức Meta Prophet (`prophet.Prophet`).

    Quy trình thực hiện:
        1. Nhận chuỗi lịch sử (dates, values) và đưa vào DataFrame với 2 cột chuẩn [ds, y].
        2. Khởi tạo mô hình Prophet với chu kỳ tuần (weekly seasonality) và khoảng tin cậy.
        3. Huấn luyện (fit) và dự báo (predict) cho N ngày tiếp theo (horizon).
        4. Trích xuất giá trị dự báo, khoảng tin cậy (lower_bound, upper_bound)
           và kẹp biên không âm (max(0.0, ...)) theo đặc thù nghiệp vụ kho vận.
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
            raise ValueError("dates và values không được rỗng và phải có cùng độ dài")

        # 1. Chuẩn bị DataFrame đúng chuẩn của Prophet (cột ds: ngày, cột y: sản lượng)
        df = pd.DataFrame(
            {
                "ds": pd.to_datetime(list(dates)),
                "y": [float(v) for v in values],
            }
        )

        # 2. Khởi tạo mô hình Meta Prophet chính thức
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

        # 3. Huấn luyện mô hình
        model.fit(df)

        # 4. Sinh bảng ngày tương lai (mặc định 7 ngày) và dự báo
        future_df = model.make_future_dataframe(periods=horizon, freq="D")
        forecast_df = model.predict(future_df)

        # 5. Lấy giá trị đã khớp (fitted values) trên tập lịch sử
        n_hist = len(dates)
        fitted_values = [
            max(0.0, round(float(v), 3)) for v in forecast_df["yhat"].iloc[:n_hist]
        ]

        # 6. Trích xuất kết quả dự báo cho horizon ngày tương lai
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
