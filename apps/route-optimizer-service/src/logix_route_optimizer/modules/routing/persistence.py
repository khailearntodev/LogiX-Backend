from __future__ import annotations

import hashlib
import json
import logging
import uuid
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from logix_route_optimizer.modules.messaging.models import OutboxEvent
from logix_route_optimizer.modules.optimization.models import (
    OptimizationMetric,
    OptimizationResult,
    OptimizationRun,
    OptimizationStop,
)
from logix_route_optimizer.modules.routing.schemas import (
    ProposedRouteOut,
    RouteOptimizationRequest,
)

logger = logging.getLogger(__name__)


def compute_input_hash(request: RouteOptimizationRequest) -> str:
    serialized = request.model_dump_json(exclude_none=True)
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


async def try_save_optimization_run(
    session: AsyncSession,
    request: RouteOptimizationRequest,
    result: ProposedRouteOut,
    tenant_id: UUID | None = None,
) -> UUID | None:
    """Save calculation run, stops, result, and outbox event in the database."""
    try:
        actual_tenant_id = tenant_id or request.tenant_id or uuid.UUID("00000000-0000-0000-0000-000000000001")
        run_id = result.route_plan_id
        route_request_id = request.route_request_id or uuid.uuid4()
        input_hash = compute_input_hash(request)
        now = datetime.now(UTC)

        run = OptimizationRun(
            id=run_id,
            tenant_id=actual_tenant_id,
            route_request_id=route_request_id,
            trip_id=result.trip_id,
            trip_version=1,
            idempotency_key=request.idempotency_key,
            status="SUCCEEDED" if result.feasibility_status == "FEASIBLE" else "INFEASIBLE",
            input_hash=input_hash,
            solver_name=result.solver_method,
            solver_version="0.1.0",
            config_version="v1",
            objective="MINIMIZE_ROAD_DISTANCE",
            parameters={"distance_provider": result.distance_provider},
            random_seed=42,
            stop_count=len(result.stops),
            vehicle_capacity_weight=Decimal(str(result.vehicle_capacity_weight_kg)),
            vehicle_capacity_volume=Decimal(str(result.vehicle_capacity_volume_m3)),
            correlation_id=uuid.uuid4(),
            started_at=now,
            completed_at=now,
            latency_ms=150,
        )
        session.add(run)

        # Add stops
        for s in result.stops:
            stop_row = OptimizationStop(
                id=uuid.uuid4(),
                tenant_id=actual_tenant_id,
                optimization_run_id=run_id,
                trip_stop_id=s.trip_stop_id,
                input_sequence=s.sequence,
                optimized_sequence=s.sequence,
                latitude=Decimal(str(round(s.lat, 6))),
                longitude=Decimal(str(round(s.lng, 6))),
                demand_weight=Decimal(str(round(s.demand_weight_kg, 3))),
                demand_volume=Decimal(str(round(s.demand_volume_m3, 3))),
                service_duration_seconds=s.estimated_duration_minutes * 60,
                distance_from_previous_m=Decimal(str(round(s.distance_from_prev_km * 1000.0, 3))),
            )
            session.add(stop_row)

        # Add result
        res_row = OptimizationResult(
            id=uuid.uuid4(),
            tenant_id=actual_tenant_id,
            optimization_run_id=run_id,
            stop_sequence=[str(s.trip_stop_id) for s in result.stops],
            legs=result.legs,
            total_distance_m=Decimal(str(round(result.total_distance_km * 1000.0, 3))),
            total_duration_seconds=result.total_duration_minutes * 60,
            baseline_type="INPUT_ORDER",
            baseline_value=Decimal(str(round(result.baseline_input_order_km * 1000.0, 3))),
            improvement_ratio=Decimal(str(round(result.improvement_ratio_percent / 100.0, 6))),
            feasibility_status=result.feasibility_status,
            input_hash=input_hash,
            model_metadata={
                "distance_provider": result.distance_provider,
                "solver_method": result.solver_method,
            },
        )
        session.add(res_row)

        # Add metrics
        metric_row = OptimizationMetric(
            id=uuid.uuid4(),
            tenant_id=actual_tenant_id,
            optimization_run_id=run_id,
            metric_name="total_distance_km",
            metric_value=Decimal(str(result.total_distance_km)),
            metric_unit="km",
            method_type="heuristic",
            method_name=result.solver_method,
        )
        session.add(metric_row)

        # Add outbox event
        outbox = OutboxEvent(
            id=uuid.uuid4(),
            tenant_id=actual_tenant_id,
            event_type="RouteCalculated",
            event_version=1,
            aggregate_type="OptimizationRun",
            aggregate_id=run_id,
            aggregate_version=1,
            correlation_id=uuid.uuid4(),
            payload={
                "trip_id": str(result.trip_id),
                "total_distance_km": result.total_distance_km,
                "feasibility_status": result.feasibility_status,
            },
            occurred_at=now,
        )
        session.add(outbox)

        await session.commit()
        return run_id
    except Exception as exc:
        logger.warning("Could not persist optimization run to DB: %s", exc)
        await session.rollback()
        return None
