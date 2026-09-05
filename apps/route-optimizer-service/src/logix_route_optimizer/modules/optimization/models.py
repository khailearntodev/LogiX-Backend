from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from uuid import UUID

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
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
from sqlalchemy.ext.mutable import MutableDict, MutableList
from sqlalchemy.orm import Mapped, mapped_column, relationship

from logix_route_optimizer.db.base import Base, SCHEMA, TenantMutableMixin


EMPTY_JSON = text("'{}'::jsonb")


class OptimizationRun(TenantMutableMixin, Base):
    __tablename__ = "optimization_runs"
    __table_args__ = (
        CheckConstraint(
            "status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'INFEASIBLE', 'CANCELED')",
            name="optimization_run_status",
        ),
        CheckConstraint("stop_count > 0", name="optimization_stop_count_positive"),
        CheckConstraint("vehicle_capacity_weight > 0", name="vehicle_weight_positive"),
        CheckConstraint("vehicle_capacity_volume > 0", name="vehicle_volume_positive"),
        CheckConstraint("random_seed >= 0", name="optimization_seed_nonnegative"),
        CheckConstraint("latency_ms IS NULL OR latency_ms >= 0", name="optimization_latency"),
        CheckConstraint(
            "trip_version IS NULL OR trip_version > 0", name="optimization_trip_version"
        ),
        CheckConstraint(
            "completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at",
            name="optimization_execution_time_order",
        ),
        UniqueConstraint("tenant_id", "id", name="uq_optimization_runs_tenant_id"),
        UniqueConstraint(
            "tenant_id",
            "route_request_id",
            name="ux_optimization_run_route_request",
        ),
        Index(
            "ux_optimization_run_idempotency",
            "tenant_id",
            "idempotency_key",
            unique=True,
            postgresql_where=text("idempotency_key IS NOT NULL"),
        ),
        Index(
            "ix_optimization_run_status_age",
            "tenant_id",
            "status",
            "created_at",
            postgresql_where=text(
                "status IN ('QUEUED', 'RUNNING') AND deleted_at IS NULL"
            ),
        ),
        Index("ix_optimization_run_trip", "tenant_id", "trip_id", "trip_version"),
        Index("ix_optimization_run_correlation", "tenant_id", "correlation_id"),
        {"schema": SCHEMA},
    )

    route_request_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), nullable=False)
    trip_id: Mapped[UUID | None] = mapped_column(PG_UUID(as_uuid=True), nullable=True)
    trip_version: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    idempotency_key: Mapped[str | None] = mapped_column(String(100), nullable=True)
    status: Mapped[str] = mapped_column(
        String(30), nullable=False, server_default=text("'QUEUED'")
    )
    input_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    input_snapshot_uri: Mapped[str | None] = mapped_column(String(500), nullable=True)
    solver_name: Mapped[str] = mapped_column(String(100), nullable=False)
    solver_version: Mapped[str] = mapped_column(String(100), nullable=False)
    config_version: Mapped[str] = mapped_column(String(100), nullable=False)
    objective: Mapped[str] = mapped_column(String(50), nullable=False)
    parameters: Mapped[dict[str, object]] = mapped_column(
        MutableDict.as_mutable(JSONB), nullable=False, default=dict, server_default=EMPTY_JSON
    )
    random_seed: Mapped[int] = mapped_column(Integer, nullable=False)
    stop_count: Mapped[int] = mapped_column(Integer, nullable=False)
    vehicle_capacity_weight: Mapped[Decimal] = mapped_column(Numeric(18, 3), nullable=False)
    vehicle_capacity_volume: Mapped[Decimal] = mapped_column(Numeric(18, 3), nullable=False)
    correlation_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), nullable=False)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    latency_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    error_code: Mapped[str | None] = mapped_column(String(100), nullable=True)
    error_message_sanitized: Mapped[str | None] = mapped_column(Text, nullable=True)
    fallback_reason: Mapped[str | None] = mapped_column(String(200), nullable=True)

    stops: Mapped[list[OptimizationStop]] = relationship(back_populates="run")
    result: Mapped[OptimizationResult | None] = relationship(back_populates="run")
    metrics: Mapped[list[OptimizationMetric]] = relationship(back_populates="run")

class OptimizationStop(TenantMutableMixin, Base):
    __tablename__ = "optimization_stops"
    __table_args__ = (
        CheckConstraint("input_sequence > 0", name="input_sequence_positive"),
        CheckConstraint(
            "optimized_sequence IS NULL OR optimized_sequence > 0",
            name="optimized_sequence_positive",
        ),
        CheckConstraint("demand_weight >= 0", name="stop_weight_nonnegative"),
        CheckConstraint("demand_volume >= 0", name="stop_volume_nonnegative"),
        CheckConstraint(
            "service_duration_seconds >= 0", name="stop_service_duration_nonnegative"
        ),
        CheckConstraint("latitude BETWEEN -90 AND 90", name="stop_latitude_range"),
        CheckConstraint("longitude BETWEEN -180 AND 180", name="stop_longitude_range"),
        CheckConstraint(
            "distance_from_previous_m IS NULL OR distance_from_previous_m >= 0",
            name="stop_distance_nonnegative",
        ),
        CheckConstraint(
            "time_window_end IS NULL OR time_window_start IS NULL "
            "OR time_window_end >= time_window_start",
            name="stop_time_window_order",
        ),
        ForeignKeyConstraint(
            ["tenant_id", "optimization_run_id"],
            [f"{SCHEMA}.optimization_runs.tenant_id", f"{SCHEMA}.optimization_runs.id"],
            name="fk_optimization_stops_tenant_run",
            ondelete="RESTRICT",
        ),
        UniqueConstraint(
            "tenant_id", "optimization_run_id", "trip_stop_id", name="ux_optimization_stop"
        ),
        Index(
            "ux_optimization_stop_sequence",
            "tenant_id",
            "optimization_run_id",
            "optimized_sequence",
            unique=True,
            postgresql_where=text("optimized_sequence IS NOT NULL"),
        ),
        Index(
            "ix_optimization_stop_input_order",
            "tenant_id",
            "optimization_run_id",
            "input_sequence",
        ),
        {"schema": SCHEMA},
    )

    optimization_run_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), nullable=False)
    trip_stop_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), nullable=False)
    input_sequence: Mapped[int] = mapped_column(Integer, nullable=False)
    optimized_sequence: Mapped[int | None] = mapped_column(Integer, nullable=True)
    latitude: Mapped[Decimal] = mapped_column(Numeric(9, 6), nullable=False)
    longitude: Mapped[Decimal] = mapped_column(Numeric(9, 6), nullable=False)
    demand_weight: Mapped[Decimal] = mapped_column(Numeric(18, 3), nullable=False)
    demand_volume: Mapped[Decimal] = mapped_column(Numeric(18, 3), nullable=False)
    service_duration_seconds: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default=text("0")
    )
    time_window_start: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    time_window_end: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    arrival_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    departure_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    distance_from_previous_m: Mapped[Decimal | None] = mapped_column(
        Numeric(18, 3), nullable=True
    )

    run: Mapped[OptimizationRun] = relationship(back_populates="stops")

class OptimizationResult(TenantMutableMixin, Base):
    __tablename__ = "optimization_results"
    __table_args__ = (
        CheckConstraint("total_distance_m >= 0", name="result_distance_nonnegative"),
        CheckConstraint(
            "total_duration_seconds >= 0", name="result_duration_nonnegative"
        ),
        CheckConstraint("total_cost IS NULL OR total_cost >= 0", name="result_cost_nonnegative"),
        CheckConstraint(
            "feasibility_status IN ('FEASIBLE', 'INFEASIBLE', 'PARTIAL', 'FALLBACK')",
            name="result_feasibility_status",
        ),
        ForeignKeyConstraint(
            ["tenant_id", "optimization_run_id"],
            [f"{SCHEMA}.optimization_runs.tenant_id", f"{SCHEMA}.optimization_runs.id"],
            name="fk_optimization_results_tenant_run",
            ondelete="RESTRICT",
        ),
        UniqueConstraint(
            "tenant_id", "optimization_run_id", name="ux_optimization_result_run"
        ),
        Index("ix_optimization_result_input_hash", "tenant_id", "input_hash"),
        {"schema": SCHEMA},
    )

    optimization_run_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), nullable=False)
    stop_sequence: Mapped[list[object]] = mapped_column(
        MutableList.as_mutable(JSONB), nullable=False, default=list
    )
    legs: Mapped[list[object]] = mapped_column(
        MutableList.as_mutable(JSONB), nullable=False, default=list
    )
    total_distance_m: Mapped[Decimal] = mapped_column(Numeric(18, 3), nullable=False)
    total_duration_seconds: Mapped[int] = mapped_column(Integer, nullable=False)
    total_cost: Mapped[Decimal | None] = mapped_column(Numeric(18, 3), nullable=True)
    baseline_type: Mapped[str] = mapped_column(String(100), nullable=False)
    baseline_value: Mapped[Decimal | None] = mapped_column(Numeric(18, 3), nullable=True)
    improvement_ratio: Mapped[Decimal | None] = mapped_column(Numeric(10, 6), nullable=True)
    feasibility_status: Mapped[str] = mapped_column(String(30), nullable=False)
    input_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    model_metadata: Mapped[dict[str, object]] = mapped_column(
        MutableDict.as_mutable(JSONB), nullable=False, default=dict, server_default=EMPTY_JSON
    )

    run: Mapped[OptimizationRun] = relationship(back_populates="result")

class OptimizationMetric(TenantMutableMixin, Base):
    __tablename__ = "optimization_metrics"
    __table_args__ = (
        CheckConstraint("metric_value >= 0", name="optimization_metric_nonnegative"),
        ForeignKeyConstraint(
            ["tenant_id", "optimization_run_id"],
            [f"{SCHEMA}.optimization_runs.tenant_id", f"{SCHEMA}.optimization_runs.id"],
            name="fk_optimization_metrics_tenant_run",
            ondelete="RESTRICT",
        ),
        UniqueConstraint(
            "tenant_id",
            "optimization_run_id",
            "metric_name",
            "method_type",
            "method_name",
            name="ux_optimization_metric_method",
        ),
        Index(
            "ix_optimization_metric_comparison",
            "tenant_id",
            "metric_name",
            "method_type",
            "method_name",
            "created_at",
        ),
        {"schema": SCHEMA},
    )

    optimization_run_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), nullable=False)
    metric_name: Mapped[str] = mapped_column(String(100), nullable=False)
    metric_value: Mapped[Decimal] = mapped_column(Numeric(18, 6), nullable=False)
    metric_unit: Mapped[str] = mapped_column(String(50), nullable=False)
    method_type: Mapped[str] = mapped_column(String(20), nullable=False)
    method_name: Mapped[str] = mapped_column(String(100), nullable=False)

    run: Mapped[OptimizationRun] = relationship(back_populates="metrics")
