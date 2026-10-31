from __future__ import annotations

import logging
import time
from datetime import UTC, datetime
from importlib.metadata import version
from uuid import UUID

import jwt
from fastapi import APIRouter, Header, HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError

from logix_route_optimizer.config import settings
from logix_route_optimizer.modules.optimization.models import OptimizationRun
from logix_route_optimizer.modules.routing.engine import RouteEngine
from logix_route_optimizer.modules.routing.persistence import try_save_optimization_run
from logix_route_optimizer.modules.routing.production_contract import (
    ProductionRouteOut,
    ProductionRouteRequest,
)
from logix_route_optimizer.modules.routing.schemas import (
    ProposedRouteOut,
    RouteOptimizationRequest,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/route-optimizations", tags=["Route Optimizations"])
route_engine = RouteEngine()


def authenticated_tenant(token: str | None) -> UUID:
    if token is None:
        raise HTTPException(401, "Internal service authentication required")
    secret = settings.internal_service_jwt_secret
    if secret is None or len(secret) < 32:
        raise HTTPException(503, "Internal authentication is not configured")
    try:
        claims = jwt.decode(token, secret, algorithms=["HS256"], audience="route-optimizer-service",
                            issuer="transport-service", options={"require": ["exp", "iat", "tenantId"]})
        if claims.get("typ") != "internal-service":
            raise ValueError("Wrong token purpose")
        return UUID(claims["tenantId"])
    except (jwt.PyJWTError, ValueError, TypeError) as exc:
        raise HTTPException(401, "Invalid internal service authentication") from exc


async def stored(tenant_id: UUID, *, request_id: UUID | None = None, run_id: UUID | None = None) -> OptimizationRun | None:
    from logix_route_optimizer.main import get_session_factory
    async with get_session_factory()() as session:
        query = select(OptimizationRun).where(OptimizationRun.tenant_id == tenant_id, OptimizationRun.deleted_at.is_(None))
        query = query.where(OptimizationRun.route_request_id == request_id) if request_id else query.where(OptimizationRun.id == run_id)
        return (await session.execute(query)).scalar_one_or_none()


def persisted_response(run: OptimizationRun, request: ProductionRouteRequest | None = None) -> ProductionRouteOut:
    if request is not None and run.parameters.get("request") != request.model_dump(mode="json"):
        raise HTTPException(409, "Route request identity was reused with different input")
    try:
        return ProductionRouteOut.model_validate(run.parameters["response"])
    except (KeyError, ValueError) as exc:
        raise HTTPException(409, "Legacy run has no production response evidence") from exc


@router.post("", response_model=ProductionRouteOut)
async def create_route_optimization(
    request: ProductionRouteRequest,
    x_internal_service_token: str | None = Header(None, alias="x-internal-service-token"),
) -> ProductionRouteOut:
    tenant_id = authenticated_tenant(x_internal_service_token)
    if tenant_id != request.tenant_id:
        raise HTTPException(403, "Request tenant differs from authenticated caller")
    if not settings.database_url:
        raise HTTPException(503, "Production persistence is required")
    try:
        prior = await stored(tenant_id, request_id=request.route_request_id)
        if prior is not None:
            return persisted_response(prior, request)
        started_at, clock = datetime.now(UTC), time.perf_counter()
        result = await route_engine.compute_route(request)
        completed_at = datetime.now(UTC)
        solver_version = version("ortools") if result.solver_method.startswith("Google OR-Tools") else version("logix-route-optimizer-service")
        response = ProductionRouteOut(
            **result.model_dump(), tenant_id=tenant_id, route_request_id=request.route_request_id,
            trip_version=request.trip_version, input_hash=request.input_hash, persisted=True,
            completed_at=completed_at.isoformat(), solver_version=solver_version,
            config_version=f"route-v1;solver-limit={route_engine.solver.time_limit_seconds}s",
            objective="MINIMIZE_ROAD_DISTANCE", provider_version=None,
        )
        from logix_route_optimizer.main import get_session_factory
        async with get_session_factory()() as session:
            await try_save_optimization_run(session, request, response, tenant_id=tenant_id,
                                            started_at=started_at, completed_at=completed_at,
                                            latency_ms=round((time.perf_counter() - clock) * 1000))
        return response
    except HTTPException:
        raise
    except IntegrityError:
        prior = await stored(tenant_id, request_id=request.route_request_id)
        if prior is not None:
            return persisted_response(prior, request)
        raise HTTPException(409, "Optimization request persistence conflict") from None
    except (SQLAlchemyError, OSError, ValueError, ArithmeticError, RuntimeError):
        logger.error("Production route calculation/persistence failed")
        raise HTTPException(503, "Route calculation or persistence unavailable") from None


@router.get("/sample", response_model=ProposedRouteOut)
async def get_sample_route() -> ProposedRouteOut:
    """Explicit demonstration only; never accepted as a bound production result."""
    return await route_engine.compute_route(RouteOptimizationRequest())


@router.get("/{run_id}", response_model=ProductionRouteOut)
async def get_route_optimization(
    run_id: UUID,
    x_internal_service_token: str | None = Header(None, alias="x-internal-service-token"),
) -> ProductionRouteOut:
    tenant_id = authenticated_tenant(x_internal_service_token)
    if not settings.database_url:
        raise HTTPException(503, "Production persistence is required")
    try:
        run = await stored(tenant_id, run_id=run_id)
        if run is None:
            raise HTTPException(404, "Optimization run not found")
        return persisted_response(run)
    except HTTPException:
        raise
    except (SQLAlchemyError, OSError, ValueError, RuntimeError):
        logger.error("Production route lookup failed")
        raise HTTPException(503, "Optimization persistence unavailable") from None
