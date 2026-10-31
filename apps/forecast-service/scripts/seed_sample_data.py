"""
Seed script for populating sample historical demand observations into
`forecast.demand_observations` for development, testing, and demonstration.

Usage:
    uv run python apps/forecast-service/scripts/seed_sample_data.py
    uv run python apps/forecast-service/scripts/seed_sample_data.py --days 56 --reset
"""

from __future__ import annotations

import argparse
import asyncio
import uuid
from datetime import date, timedelta
from decimal import Decimal
from uuid import UUID

from logix_forecast.config import settings
from logix_forecast.db.base import SCHEMA, Base
from logix_forecast.db.session import create_engine, create_session_factory
from logix_forecast.modules.demand.models import DemandObservation
from logix_forecast.modules.forecasts.schemas import DEFAULT_TENANT_ID
from sqlalchemy import delete, select, text

SAMPLE_WAREHOUSES: list[UUID] = [
    UUID("00000000-0000-0000-0000-000000000101"),
    UUID("00000000-0000-0000-0000-000000000102"),
]

SAMPLE_PRODUCTS: list[dict[str, object]] = [
    {
        "product_id": UUID("00000000-0000-0000-0000-000000000201"),
        "sku_code": "SKU-FMCG-001",
        "base_demand": 42.0,
        "daily_trend": 0.35,
    },
    {
        "product_id": UUID("00000000-0000-0000-0000-000000000202"),
        "sku_code": "SKU-PACK-002",
        "base_demand": 50.0,
        "daily_trend": 0.20,
    },
]

WEEKLY_FACTORS: list[float] = [0.80, 0.90, 0.95, 1.05, 1.20, 1.35, 0.75]


def generate_series_rows(
    *,
    tenant_id: UUID,
    warehouse_id: UUID,
    product_id: UUID,
    days: int,
    base_demand: float,
    daily_trend: float,
    end_date: date,
) -> list[DemandObservation]:
    start_date = end_date - timedelta(days=days - 1)
    rows: list[DemandObservation] = []

    for idx in range(days):
        curr_date = start_date + timedelta(days=idx)
        factor = WEEKLY_FACTORS[curr_date.weekday()]
        qty = round((base_demand + daily_trend * idx) * factor, 3)
        seed_key = f"{tenant_id}:{warehouse_id}:{product_id}:{curr_date.isoformat()}"

        rows.append(
            DemandObservation(
                id=uuid.uuid5(uuid.NAMESPACE_OID, f"obs:{seed_key}"),
                tenant_id=tenant_id,
                warehouse_id=warehouse_id,
                product_id=product_id,
                demand_date=curr_date,
                fulfilled_quantity=Decimal(str(qty)),
                source_event_id=uuid.uuid5(uuid.NAMESPACE_OID, f"evt:{seed_key}"),
                source_order_id=uuid.uuid5(uuid.NAMESPACE_OID, f"ord:{seed_key}"),
                source_version=1,
            )
        )
    return rows


async def seed_demand_observations(
    *,
    tenant_id: UUID,
    days: int = 56,
    reset: bool = False,
) -> int:
    engine = create_engine(settings.database_url)
    session_factory = create_session_factory(engine)

    try:
        async with engine.begin() as conn:
            await conn.execute(text(f"CREATE SCHEMA IF NOT EXISTS {SCHEMA}"))
            await conn.run_sync(Base.metadata.create_all)

        anchor_end = date(2026, 10, 30)
        inserted_count = 0

        async with session_factory() as session:
            if reset:
                await session.execute(
                    delete(DemandObservation).where(
                        DemandObservation.tenant_id == tenant_id
                    )
                )

            for wh_idx, warehouse_id in enumerate(SAMPLE_WAREHOUSES):
                wh_scale = 1.0 if wh_idx == 0 else 0.85
                for prod in SAMPLE_PRODUCTS:
                    product_id = prod["product_id"]
                    assert isinstance(product_id, UUID)
                    base_demand = float(prod["base_demand"]) * wh_scale  # type: ignore[arg-type]
                    daily_trend = float(prod["daily_trend"]) * wh_scale  # type: ignore[arg-type]

                    existing_count = len(
                        (
                            await session.execute(
                                select(DemandObservation.id).where(
                                    DemandObservation.tenant_id == tenant_id,
                                    DemandObservation.warehouse_id == warehouse_id,
                                    DemandObservation.product_id == product_id,
                                )
                            )
                        )
                        .scalars()
                        .all()
                    )
                    if existing_count > 0 and not reset:
                        continue

                    rows = generate_series_rows(
                        tenant_id=tenant_id,
                        warehouse_id=warehouse_id,
                        product_id=product_id,
                        days=days,
                        base_demand=base_demand,
                        daily_trend=daily_trend,
                        end_date=anchor_end,
                    )
                    session.add_all(rows)
                    inserted_count += len(rows)

            await session.commit()
        return inserted_count
    finally:
        await engine.dispose()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Seed sample historical demand observations into forecast.demand_observations."
    )
    parser.add_argument(
        "--tenant-id",
        type=UUID,
        default=DEFAULT_TENANT_ID,
        help="Target tenant UUID (default: 00000000-0000-0000-0000-000000000001)",
    )
    parser.add_argument(
        "--days",
        type=int,
        default=56,
        help="Number of historical days per SKU-warehouse series (default: 56)",
    )
    parser.add_argument(
        "--reset",
        action="store_true",
        help="Delete existing observations for the tenant before seeding",
    )
    args = parser.parse_args()

    inserted = asyncio.run(
        seed_demand_observations(
            tenant_id=args.tenant_id,
            days=args.days,
            reset=args.reset,
        )
    )
    print(
        f"Seeded {inserted} demand observation rows into {SCHEMA}.demand_observations "
        f"(tenant_id={args.tenant_id})."
    )


if __name__ == "__main__":
    main()
