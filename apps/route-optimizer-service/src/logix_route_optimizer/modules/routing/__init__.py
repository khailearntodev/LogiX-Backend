"""Routing engine and schemas for delivery tours."""

from logix_route_optimizer.modules.routing.checker import CheckReport, SolutionChecker
from logix_route_optimizer.modules.routing.defaults import (
    DEFAULT_DEPOT,
    DEFAULT_SAMPLE_STOPS,
    DEFAULT_VEHICLE,
)
from logix_route_optimizer.modules.routing.engine import RouteEngine
from logix_route_optimizer.modules.routing.schemas import (
    LocationIn,
    ProposedRouteOut,
    RouteOptimizationRequest,
    StopDetailOut,
    StopIn,
    VehicleIn,
)
from logix_route_optimizer.modules.routing.solver import ORToolsCVRPSolver, SolverResult

__all__ = [
    "CheckReport",
    "DEFAULT_DEPOT",
    "DEFAULT_SAMPLE_STOPS",
    "DEFAULT_VEHICLE",
    "LocationIn",
    "ORToolsCVRPSolver",
    "ProposedRouteOut",
    "RouteEngine",
    "RouteOptimizationRequest",
    "SolutionChecker",
    "SolverResult",
    "StopDetailOut",
    "StopIn",
    "VehicleIn",
]
