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


class DemandObservation(TenantMutableMixin, Base):
    __tablename__ = "demand_observations"
    __table_args__ = (
        CheckConstraint("fulfilled_quantity >= 0", name="fulfilled_quantity_nonnegative"),
        CheckConstraint("source_version > 0", name="source_version_positive"),
        UniqueConstraint(
            "tenant_id",
            "source_event_id",
            "product_id",
            name="ux_demand_observation_event_product",
        ),
        UniqueConstraint(
            "tenant_id",
            "source_order_id",
            "product_id",
            "source_version",
            name="ux_demand_observation_order_product_version",
        ),
        Index(
            "ix_demand_observation_series_date",
            "tenant_id",
            "warehouse_id",
            "product_id",
            "demand_date",
        ),
        {"schema": SCHEMA},
    )

    warehouse_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), nullable=False)
    product_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), nullable=False)
    demand_date: Mapped[date] = mapped_column(Date, nullable=False)
    fulfilled_quantity: Mapped[Decimal] = mapped_column(Numeric(18, 3), nullable=False)
    source_event_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), nullable=False)
    source_order_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), nullable=False)
    source_version: Mapped[int] = mapped_column(BigInteger, nullable=False)
