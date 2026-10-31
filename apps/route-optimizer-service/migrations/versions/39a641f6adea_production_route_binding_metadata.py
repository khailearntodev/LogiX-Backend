"""production_route_binding_metadata

Revision ID: 39a641f6adea
Revises: 20260905_0001
Create Date: 2026-10-25 22:04:13.768682
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = '39a641f6adea'
down_revision: str | Sequence[str] | None = '20260905_0001'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.alter_column("optimization_runs", "random_seed", nullable=True, schema="route_optimizer")
    op.alter_column("optimization_runs", "vehicle_capacity_volume", type_=sa.Numeric(18, 6), schema="route_optimizer")
    op.alter_column("optimization_stops", "demand_volume", type_=sa.Numeric(18, 6), schema="route_optimizer")


def downgrade() -> None:
    raise RuntimeError("Forward-only: preserve six-decimal volume and unknown seed evidence")
