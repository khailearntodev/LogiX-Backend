from __future__ import annotations

import logging
from uuid import UUID

from fastapi import APIRouter, Header, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from logix_route_optimizer.config import settings
from logix_route_optimizer.modules.optimization.models import (
    OptimizationResult,
    OptimizationRun,
)
from logix_route_optimizer.modules.routing.engine import RouteEngine
from logix_route_optimizer.modules.routing.persistence import try_save_optimization_run
from logix_route_optimizer.modules.routing.schemas import (
    ProposedRouteOut,
    RouteOptimizationRequest,
    StopDetailOut,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/route-optimizations", tags=["Route Optimizations"])
route_engine = RouteEngine()


@router.post(
    "",
    response_model=ProposedRouteOut,
    status_code=status.HTTP_200_OK,
    summary="Compute delivery route proposal",
    description=(
        "Computes an sequential / optimized route tour for a delivery trip with road network distances, "
        "duration estimates, baseline comparisons, and vehicle capacity checks."
    ),
)
async def create_route_optimization(
    request: RouteOptimizationRequest,
    x_tenant_id: str | None = Header(None, alias="X-Tenant-Id"),
) -> ProposedRouteOut:
    # 1. Compute the route using RouteEngine
    result = await route_engine.compute_route(request)

    # 2. Attempt database persistence if configured
    if settings.database_url:
        try:
            from logix_route_optimizer.main import get_session_factory

            session_factory = get_session_factory()
            tenant_uuid = UUID(x_tenant_id) if x_tenant_id else request.tenant_id
            async with session_factory() as session:
                await try_save_optimization_run(session, request, result, tenant_id=tenant_uuid)
        except Exception as exc:
            logger.warning("Could not persist optimization run: %s", exc)

    return result


@router.get(
    "/sample",
    response_model=ProposedRouteOut,
    summary="Get sample TP.HCM route proposal",
)
async def get_sample_route() -> ProposedRouteOut:
    """Returns sample route proposal in central TP.HCM."""
    return await route_engine.compute_route(RouteOptimizationRequest())


@router.get(
    "/{run_id}",
    response_model=ProposedRouteOut,
    summary="Get optimization run by ID",
)
async def get_route_optimization(
    run_id: UUID,
    x_tenant_id: str | None = Header(None, alias="X-Tenant-Id"),
) -> ProposedRouteOut:
    """Query stored optimization run from database, or fallback to computed trip."""
    if settings.database_url:
        try:
            from logix_route_optimizer.main import get_session_factory

            session_factory = get_session_factory()
            async with session_factory() as session:
                query = (
                    select(OptimizationRun)
                    .options(
                        selectinload(OptimizationRun.stops),
                        selectinload(OptimizationRun.result),
                    )
                    .where(OptimizationRun.id == run_id)
                )
                if x_tenant_id:
                    query = query.where(OptimizationRun.tenant_id == UUID(x_tenant_id))

                db_res = await session.execute(query)
                run = db_res.scalar_one_or_none()

                if run and run.result:
                    stop_details = [
                        StopDetailOut(
                            trip_stop_id=s.trip_stop_id,
                            sequence=s.optimized_sequence or s.input_sequence,
                            stop_name=f"Điểm dừng #{s.input_sequence}",
                            address=f"Tọa độ {s.latitude}, {s.longitude}",
                            lat=float(s.latitude),
                            lng=float(s.longitude),
                            demand_weight_kg=float(s.demand_weight),
                            demand_volume_m3=float(s.demand_volume),
                            distance_from_prev_km=float((s.distance_from_previous_m or 0) / 1000),
                            estimated_duration_minutes=int(s.service_duration_seconds / 60),
                        )
                        for s in sorted(run.stops, key=lambda x: x.input_sequence)
                    ]

                    total_dist_km = float(run.result.total_distance_m / 1000)
                    baseline_km = float((run.result.baseline_value or 0) / 1000)

                    return ProposedRouteOut(
                        trip_id=run.trip_id or run.id,
                        route_plan_id=run.id,
                        depot_name="Kho Tổng",
                        depot_address="TP.HCM",
                        depot_lat=10.8015,
                        depot_lng=106.6542,
                        total_distance_km=total_dist_km,
                        total_duration_minutes=int(run.result.total_duration_seconds / 60),
                        baseline_input_order_km=baseline_km,
                        baseline_nearest_neighbor_km=baseline_km,
                        distance_saved_km=max(0.0, baseline_km - total_dist_km),
                        improvement_ratio_percent=float((run.result.improvement_ratio or 0) * 100),
                        vehicle_capacity_weight_kg=float(run.vehicle_capacity_weight),
                        total_demand_weight_kg=float(sum(s.demand_weight for s in run.stops)),
                        vehicle_capacity_volume_m3=float(run.vehicle_capacity_volume),
                        total_demand_volume_m3=float(sum(s.demand_volume for s in run.stops)),
                        feasibility_status=run.result.feasibility_status,
                        solver_method=run.solver_name,
                        distance_provider=str(run.parameters.get("distance_provider", "OSRM")),
                        stops=stop_details,
                        recommended_action="Phương án lộ trình từ cơ sở dữ liệu.",
                    )
        except Exception as exc:
            logger.warning("Error fetching run %s: %s", run_id, exc)

    # If not found in DB or DB not available, return sample for requested ID
    return await route_engine.compute_route(RouteOptimizationRequest(trip_id=run_id))
