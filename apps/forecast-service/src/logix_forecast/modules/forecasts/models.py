from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from uuid import UUID

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKeyConstraint,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.ext.mutable import MutableDict
from sqlalchemy.orm import Mapped, mapped_column, relationship

from logix_forecast.db.base import Base, SCHEMA, TenantMutableMixin


EMPTY_JSON = text("'{}'::jsonb")


class ForecastRun(TenantMutableMixin, Base):
    __tablename__ = "forecast_runs"
    __table_args__ = (
        CheckConstraint(
            "status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED')",
            name="forecast_run_status",
        ),
        CheckConstraint("horizon_days > 0", name="forecast_horizon_positive"),
        CheckConstraint(
            "training_end_date >= training_start_date", name="forecast_training_range"
        ),
        CheckConstraint("random_seed >= 0", name="forecast_random_seed_nonnegative"),
        CheckConstraint("latency_ms IS NULL OR latency_ms >= 0", name="forecast_latency"),
        CheckConstraint(
            "completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at",
            name="forecast_execution_time_order",
        ),
        UniqueConstraint("tenant_id", "id", name="uq_forecast_runs_tenant_id"),
        Index(
            "ux_forecast_run_idempotency",
            "tenant_id",
            "idempotency_key",
            unique=True,
            postgresql_where=text("idempotency_key IS NOT NULL"),
        ),
        Index(
            "ix_forecast_run_status_age",
            "tenant_id",
            "status",
            "created_at",
            postgresql_where=text(
                "status IN ('QUEUED', 'RUNNING') AND deleted_at IS NULL"
            ),
        ),
        Index("ix_forecast_run_correlation", "tenant_id", "correlation_id"),
        {"schema": SCHEMA},
    )

    status: Mapped[str] = mapped_column(
        String(30), nullable=False, server_default=text("'QUEUED'")
    )
    trigger_type: Mapped[str] = mapped_column(String(50), nullable=False)
    requested_by: Mapped[UUID | None] = mapped_column(PG_UUID(as_uuid=True), nullable=True)
    horizon_days: Mapped[int] = mapped_column(Integer, nullable=False)
    training_start_date: Mapped[date] = mapped_column(Date, nullable=False)
    training_end_date: Mapped[date] = mapped_column(Date, nullable=False)
    model_name: Mapped[str] = mapped_column(String(100), nullable=False)
    model_version: Mapped[str] = mapped_column(String(100), nullable=False)
    baseline_name: Mapped[str] = mapped_column(String(100), nullable=False)
    parameters: Mapped[dict[str, object]] = mapped_column(
        MutableDict.as_mutable(JSONB), nullable=False, default=dict, server_default=EMPTY_JSON
    )
    dataset_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    random_seed: Mapped[int] = mapped_column(Integer, nullable=False)
    correlation_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), nullable=False)
    idempotency_key: Mapped[str | None] = mapped_column(String(100), nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    latency_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    error_code: Mapped[str | None] = mapped_column(String(100), nullable=True)
    error_message_sanitized: Mapped[str | None] = mapped_column(Text, nullable=True)

    series: Mapped[list[ForecastSeries]] = relationship(back_populates="run")

class ForecastSeries(TenantMutableMixin, Base):
    __tablename__ = "forecast_series"
    __table_args__ = (
        CheckConstraint(
            "status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'INSUFFICIENT_DATA')",
            name="forecast_series_status",
        ),
        CheckConstraint("observation_count >= 0", name="observation_count_nonnegative"),
        CheckConstraint(
            "confidence_level > 0 AND confidence_level < 1",
            name="forecast_series_confidence_range",
        ),
        ForeignKeyConstraint(
            ["tenant_id", "forecast_run_id"],
            [f"{SCHEMA}.forecast_runs.tenant_id", f"{SCHEMA}.forecast_runs.id"],
            name="fk_forecast_series_tenant_run",
            ondelete="RESTRICT",
        ),
        UniqueConstraint("tenant_id", "id", name="uq_forecast_series_tenant_id"),
        UniqueConstraint(
            "tenant_id",
            "forecast_run_id",
            "warehouse_id",
            "product_id",
            name="ux_forecast_series_run_scope",
        ),
        Index(
            "ix_forecast_series_lookup",
            "tenant_id",
            "warehouse_id",
            "product_id",
            "created_at",
        ),
        {"schema": SCHEMA},
    )

    forecast_run_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), nullable=False)
    warehouse_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), nullable=False)
    product_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), nullable=False)
    status: Mapped[str] = mapped_column(
        String(30), nullable=False, server_default=text("'QUEUED'")
    )
    observation_count: Mapped[int] = mapped_column(Integer, nullable=False)
    confidence_level: Mapped[Decimal] = mapped_column(Numeric(5, 4), nullable=False)
    used_fallback: Mapped[bool] = mapped_column(
        nullable=False, default=False, server_default=text("false")
    )
    fallback_reason: Mapped[str | None] = mapped_column(String(200), nullable=True)
    model_artifact_uri: Mapped[str | None] = mapped_column(String(500), nullable=True)
    model_artifact_checksum: Mapped[str | None] = mapped_column(String(64), nullable=True)

    run: Mapped[ForecastRun] = relationship(back_populates="series")
    results: Mapped[list[ForecastResult]] = relationship(back_populates="series")
    metrics: Mapped[list[ForecastMetric]] = relationship(back_populates="series")

class ForecastResult(TenantMutableMixin, Base):
    __tablename__ = "forecast_results"
    __table_args__ = (
        CheckConstraint("predicted_quantity >= 0", name="predicted_quantity_nonnegative"),
        CheckConstraint(
            "lower_bound IS NULL OR lower_bound >= 0", name="lower_bound_nonnegative"
        ),
        CheckConstraint(
            "upper_bound IS NULL OR upper_bound >= 0", name="upper_bound_nonnegative"
        ),
        CheckConstraint(
            "baseline_naive IS NULL OR baseline_naive >= 0",
            name="baseline_naive_nonnegative",
        ),
        CheckConstraint(
            "baseline_moving_average_7 IS NULL OR baseline_moving_average_7 >= 0",
            name="baseline_moving_average_nonnegative",
        ),
        CheckConstraint(
            "actual_quantity IS NULL OR actual_quantity >= 0",
            name="actual_quantity_nonnegative",
        ),
        CheckConstraint(
            "confidence_level > 0 AND confidence_level < 1",
            name="forecast_result_confidence_range",
        ),
        CheckConstraint(
            "lower_bound IS NULL OR upper_bound IS NULL OR upper_bound >= lower_bound",
            name="forecast_bounds_order",
        ),
        ForeignKeyConstraint(
            ["tenant_id", "forecast_series_id"],
            [f"{SCHEMA}.forecast_series.tenant_id", f"{SCHEMA}.forecast_series.id"],
            name="fk_forecast_results_tenant_series",
            ondelete="RESTRICT",
        ),
        UniqueConstraint(
            "tenant_id",
            "forecast_series_id",
            "forecast_date",
            name="ux_forecast_result_series_date",
        ),
        Index("ix_forecast_result_date", "tenant_id", "forecast_date"),
        {"schema": SCHEMA},
    )

    forecast_series_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), nullable=False)
    forecast_date: Mapped[date] = mapped_column(Date, nullable=False)
    predicted_quantity: Mapped[Decimal] = mapped_column(Numeric(18, 3), nullable=False)
    lower_bound: Mapped[Decimal | None] = mapped_column(Numeric(18, 3), nullable=True)
    upper_bound: Mapped[Decimal | None] = mapped_column(Numeric(18, 3), nullable=True)
    baseline_naive: Mapped[Decimal | None] = mapped_column(Numeric(18, 3), nullable=True)
    baseline_moving_average_7: Mapped[Decimal | None] = mapped_column(
        Numeric(18, 3), nullable=True
    )
    actual_quantity: Mapped[Decimal | None] = mapped_column(Numeric(18, 3), nullable=True)
    confidence_level: Mapped[Decimal] = mapped_column(Numeric(5, 4), nullable=False)
    model_metadata: Mapped[dict[str, object]] = mapped_column(
        MutableDict.as_mutable(JSONB), nullable=False, default=dict, server_default=EMPTY_JSON
    )
    actual_updated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    series: Mapped[ForecastSeries] = relationship(back_populates="results")

class ForecastMetric(TenantMutableMixin, Base):
    __tablename__ = "forecast_metrics"
    __table_args__ = (
        CheckConstraint("metric_name IN ('MAPE', 'RMSE')", name="forecast_metric_name"),
        CheckConstraint("method_type IN ('MODEL', 'BASELINE')", name="forecast_method_type"),
        CheckConstraint("metric_value IS NULL OR metric_value >= 0", name="metric_nonnegative"),
        CheckConstraint("eligible_point_count >= 0", name="eligible_points_nonnegative"),
        CheckConstraint("total_point_count >= 0", name="total_points_nonnegative"),
        CheckConstraint(
            "eligible_point_count <= total_point_count", name="eligible_points_within_total"
        ),
        CheckConstraint(
            "evaluation_end_date >= evaluation_start_date", name="metric_evaluation_range"
        ),
        ForeignKeyConstraint(
            ["tenant_id", "forecast_series_id"],
            [f"{SCHEMA}.forecast_series.tenant_id", f"{SCHEMA}.forecast_series.id"],
            name="fk_forecast_metrics_tenant_series",
            ondelete="RESTRICT",
        ),
        UniqueConstraint(
            "tenant_id",
            "forecast_series_id",
            "metric_name",
            "method_type",
            "method_name",
            "evaluation_start_date",
            "evaluation_end_date",
            name="ux_forecast_metric_evaluation",
        ),
        Index(
            "ix_forecast_metric_comparison",
            "tenant_id",
            "metric_name",
            "method_type",
            "method_name",
            "calculated_at",
        ),
        {"schema": SCHEMA},
    )

    forecast_series_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), nullable=False)
    metric_name: Mapped[str] = mapped_column(String(20), nullable=False)
    metric_value: Mapped[Decimal | None] = mapped_column(Numeric(18, 6), nullable=True)
    method_type: Mapped[str] = mapped_column(String(20), nullable=False)
    method_name: Mapped[str] = mapped_column(String(100), nullable=False)
    evaluation_start_date: Mapped[date] = mapped_column(Date, nullable=False)
    evaluation_end_date: Mapped[date] = mapped_column(Date, nullable=False)
    zero_actual_policy: Mapped[str] = mapped_column(String(50), nullable=False)
    eligible_point_count: Mapped[int] = mapped_column(Integer, nullable=False)
    total_point_count: Mapped[int] = mapped_column(Integer, nullable=False)
    calculated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=text("CURRENT_TIMESTAMP")
    )

    series: Mapped[ForecastSeries] = relationship(back_populates="metrics")
