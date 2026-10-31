from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from logix_route_optimizer.modules.messaging.models import OutboxEvent
from logix_route_optimizer.modules.optimization.models import (
    OptimizationMetric,
    OptimizationResult,
    OptimizationRun,
    OptimizationStop,
)
from logix_route_optimizer.modules.routing.production_contract import (
    ProductionRouteOut,
    ProductionRouteRequest,
    input_hash,
)


def compute_input_hash(request: ProductionRouteRequest) -> str:
    return input_hash(request.input_snapshot)


async def try_save_optimization_run(
    session: AsyncSession,
    request: ProductionRouteRequest,
    result: ProductionRouteOut,
    tenant_id: UUID,
    *,
    started_at: datetime,
    completed_at: datetime,
    latency_ms: int,
) -> UUID:
    """Commit the exact request/result and all quantitative evidence, or fail closed."""
    if tenant_id != request.tenant_id or result.input_hash != compute_input_hash(request):
        raise ValueError("Optimization persistence binding mismatch")
    run_id = result.route_plan_id
    run = OptimizationRun(
        id=run_id, tenant_id=tenant_id, route_request_id=request.route_request_id,
        trip_id=request.trip_id, trip_version=request.trip_version, idempotency_key=str(request.idempotency_key),
        status="SUCCEEDED" if result.feasibility_status == "FEASIBLE" else "INFEASIBLE",
        input_hash=request.input_hash, solver_name=result.solver_method, solver_version=result.solver_version,
        config_version=result.config_version, objective=result.objective,
        parameters={"request": request.model_dump(mode="json"), "response": result.model_dump(mode="json")},
        random_seed=None, stop_count=len(result.stops),
        vehicle_capacity_weight=Decimal(request.input_snapshot["vehicle"]["capacityWeight"]),
        vehicle_capacity_volume=Decimal(request.input_snapshot["vehicle"]["capacityVolume"]),
        correlation_id=request.route_request_id, started_at=started_at, completed_at=completed_at, latency_ms=latency_ms,
    )
    session.add(run)
    for stop in result.stops:
        original = next(item for item in request.input_snapshot["stops"] if item["stopId"] == str(stop.trip_stop_id))
        session.add(OptimizationStop(
            id=uuid.uuid4(), tenant_id=tenant_id, optimization_run_id=run_id,
            trip_stop_id=stop.trip_stop_id, input_sequence=original["sequence"], optimized_sequence=stop.sequence,
            latitude=Decimal(original["addressSnapshot"]["latitude"]), longitude=Decimal(original["addressSnapshot"]["longitude"]),
            demand_weight=Decimal(original["demandWeight"]), demand_volume=Decimal(original["demandVolume"]),
            service_duration_seconds=0,
            distance_from_previous_m=Decimal(str(stop.distance_from_prev_km)) * 1000,
        ))
    session.add(OptimizationResult(
        id=uuid.uuid4(), tenant_id=tenant_id, optimization_run_id=run_id,
        stop_sequence=[str(stop.trip_stop_id) for stop in result.stops], legs=result.legs,
        total_distance_m=Decimal(str(result.total_distance_km)) * 1000,
        total_duration_seconds=result.total_duration_minutes * 60, baseline_type="INPUT_ORDER",
        baseline_value=Decimal(str(result.baseline_input_order_km)) * 1000,
        improvement_ratio=Decimal(str(result.improvement_ratio_percent)) / 100,
        feasibility_status=result.feasibility_status, input_hash=request.input_hash,
        model_metadata={"distance_provider": result.distance_provider, "provider_version": result.provider_version,
                        "solver_method": result.solver_method, "solver_version": result.solver_version,
                        "config_version": result.config_version},
    ))
    session.add(OptimizationMetric(
        id=uuid.uuid4(), tenant_id=tenant_id, optimization_run_id=run_id,
        metric_name="total_distance_km", metric_value=Decimal(str(result.total_distance_km)),
        metric_unit="km", method_type="solver", method_name=result.solver_method,
    ))
    session.add(OutboxEvent(
        id=uuid.uuid4(), tenant_id=tenant_id, event_type="RouteCalculated", event_version=1,
        aggregate_type="OptimizationRun", aggregate_id=run_id, aggregate_version=1,
        correlation_id=request.route_request_id,
        payload={"trip_id": str(request.trip_id), "route_request_id": str(request.route_request_id),
                 "input_hash": request.input_hash, "total_distance_km": result.total_distance_km,
                 "feasibility_status": result.feasibility_status},
        occurred_at=completed_at,
    ))
    try:
        await session.commit()
    except Exception:
        await session.rollback()
        raise
    return run_id
