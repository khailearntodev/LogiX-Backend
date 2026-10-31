from __future__ import annotations

from dataclasses import dataclass

from logix_forecast.engine.preprocessor import PreprocessedSeries


@dataclass(frozen=True)
class FallbackDecision:
    should_fallback: bool
    reason: str | None
    confidence_level: float


def check_fallback_condition(
    series: PreprocessedSeries,
    *,
    min_observations: int = 14,
    max_zero_ratio: float = 0.85,
    default_confidence: float = 0.80,
) -> FallbackDecision:
    """
    Determines whether the time series has insufficient observations (< 14 days)
    or extreme sparsity (> 85% zeros or < 4 non-zero days), requiring safe fallback
    to Moving Average 7 (MA-7) with lowered confidence (0.50).
    """
    if series.total_days < min_observations:
        return FallbackDecision(
            should_fallback=True,
            reason=f"INSUFFICIENT_HISTORY_LT_{min_observations}_DAYS (observed={series.total_days})",
            confidence_level=0.50,
        )

    if series.nonzero_count < 4 or series.zero_ratio > max_zero_ratio:
        return FallbackDecision(
            should_fallback=True,
            reason=f"EXTREME_ZERO_SPARSITY (zero_ratio={series.zero_ratio:.2f}, nonzero={series.nonzero_count})",
            confidence_level=0.50,
        )

    return FallbackDecision(
        should_fallback=False,
        reason=None,
        confidence_level=default_confidence,
    )
