from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import Any

from ortools.constraint_solver import pywrapcp, routing_enums_pb2

logger = logging.getLogger(__name__)


@dataclass
class SolverResult:
    ordered_stop_indices: list[int]  # 1-indexed stop indices, e.g. [3, 1, 2]
    total_distance_m: float
    solver_latency_ms: float
    status: str  # "OPTIMAL", "FEASIBLE", "INFEASIBLE", "FALLBACK"
    solver_name: str
    message: str


class ORToolsCVRPSolver:
    """
    Capacitated Vehicle Routing Problem (CVRP) solver using Google OR-Tools.
    Optimizes depot -> stops -> depot loop subject to dual vehicle capacity constraints
    (weight in kg and volume in m3).
    """

    def __init__(self, time_limit_seconds: int = 2) -> None:
        self.time_limit_seconds = time_limit_seconds

    def solve(
        self,
        distance_matrix_m: list[list[float]],
        demand_weights_kg: list[float],
        demand_volumes_m3: list[float],
        capacity_weight_kg: float,
        capacity_volume_m3: float,
        time_limit_seconds: int | None = None,
    ) -> SolverResult:
        """
        Solve single-vehicle CVRP.
        Node 0 is always the depot.
        Nodes 1..N are delivery stops.

        demand_weights_kg and demand_volumes_m3 must have length N+1 (index 0 is depot = 0.0).
        """
        start_time = time.perf_counter()
        num_nodes = len(distance_matrix_m)
        num_stops = num_nodes - 1

        if num_stops <= 0:
            return SolverResult(
                ordered_stop_indices=[],
                total_distance_m=0.0,
                solver_latency_ms=0.0,
                status="FEASIBLE",
                solver_name="Google OR-Tools CVRP Solver",
                message="No stops to optimize.",
            )

        if num_stops == 1:
            dist = distance_matrix_m[0][1] + distance_matrix_m[1][0]
            elapsed_ms = (time.perf_counter() - start_time) * 1000.0
            return SolverResult(
                ordered_stop_indices=[1],
                total_distance_m=dist,
                solver_latency_ms=round(elapsed_ms, 2),
                status="OPTIMAL",
                solver_name="Google OR-Tools CVRP Solver",
                message="Single stop route.",
            )

        # Quick check for total overcapacity
        total_weight = sum(demand_weights_kg[1:])
        total_volume = sum(demand_volumes_m3[1:])
        if total_weight > capacity_weight_kg or total_volume > capacity_volume_m3:
            elapsed_ms = (time.perf_counter() - start_time) * 1000.0
            return SolverResult(
                ordered_stop_indices=list(range(1, num_stops + 1)),
                total_distance_m=0.0,
                solver_latency_ms=round(elapsed_ms, 2),
                status="INFEASIBLE",
                solver_name="Google OR-Tools CVRP Solver",
                message=(
                    f"Tổng nhu cầu vượt quá sức chứa xe: "
                    f"trọng lượng {total_weight:.1f}kg/{capacity_weight_kg:.1f}kg, "
                    f"thể tích {total_volume:.2f}m3/{capacity_volume_m3:.2f}m3."
                ),
            )

        # Setup OR-Tools routing model (1 vehicle, depot is node 0)
        manager = pywrapcp.RoutingIndexManager(num_nodes, 1, 0)
        routing = pywrapcp.RoutingModel(manager)

        # 1. Distance transit callback (distance matrix rounded to integer meters)
        def distance_callback(from_index: int, to_index: int) -> int:
            from_node = manager.IndexToNode(from_index)
            to_node = manager.IndexToNode(to_index)
            return int(round(distance_matrix_m[from_node][to_node]))

        transit_callback_index = routing.RegisterTransitCallback(distance_callback)
        routing.SetArcCostEvaluatorOfAllVehicles(transit_callback_index)

        # 2. Dual capacity constraints:
        # Constraint A: Weight (in integer grams or rounded integer kg)
        def weight_callback(from_index: int) -> int:
            from_node = manager.IndexToNode(from_index)
            return int(round(demand_weights_kg[from_node]))

        weight_callback_idx = routing.RegisterUnaryTransitCallback(weight_callback)
        routing.AddDimensionWithVehicleCapacity(
            weight_callback_idx,
            0,  # null capacity slack
            [int(round(capacity_weight_kg))],
            True,  # start cumul to zero
            "CapacityWeight",
        )

        # Constraint B: Volume (scaled to integer liters: 1 m3 = 1000 liters)
        def volume_callback(from_index: int) -> int:
            from_node = manager.IndexToNode(from_index)
            return int(round(demand_volumes_m3[from_node] * 1000.0))

        volume_callback_idx = routing.RegisterUnaryTransitCallback(volume_callback)
        routing.AddDimensionWithVehicleCapacity(
            volume_callback_idx,
            0,  # null capacity slack
            [int(round(capacity_volume_m3 * 1000.0))],
            True,  # start cumul to zero
            "CapacityVolume",
        )

        # 3. Search parameters
        search_parameters = pywrapcp.DefaultRoutingSearchParameters()
        search_parameters.first_solution_strategy = (
            routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC
        )
        search_parameters.local_search_metaheuristic = (
            routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
        )
        limit = time_limit_seconds if time_limit_seconds is not None else self.time_limit_seconds
        search_parameters.time_limit.seconds = max(1, limit)

        # 4. Solve
        solution = routing.SolveWithParameters(search_parameters)
        elapsed_ms = (time.perf_counter() - start_time) * 1000.0

        if not solution:
            logger.warning("OR-Tools could not find a solution for %d stops within time limit", num_stops)
            return SolverResult(
                ordered_stop_indices=list(range(1, num_stops + 1)),
                total_distance_m=0.0,
                solver_latency_ms=round(elapsed_ms, 2),
                status="FALLBACK",
                solver_name="Google OR-Tools CVRP Solver",
                message="OR-Tools không tìm ra nghiệm trong thời gian giới hạn, chuyển sang fallback.",
            )

        # 5. Extract optimal tour
        index = routing.Start(0)
        route_nodes: list[int] = []
        route_distance_m = 0.0

        while not routing.IsEnd(index):
            node = manager.IndexToNode(index)
            if node != 0:
                route_nodes.append(node)
            previous_index = index
            index = solution.Value(routing.NextVar(index))
            from_node = manager.IndexToNode(previous_index)
            to_node = manager.IndexToNode(index)
            route_distance_m += distance_matrix_m[from_node][to_node]

        solver_status = "OPTIMAL" if routing.status() == 1 else "FEASIBLE"

        return SolverResult(
            ordered_stop_indices=route_nodes,
            total_distance_m=route_distance_m,
            solver_latency_ms=round(elapsed_ms, 2),
            status=solver_status,
            solver_name="Google OR-Tools CVRP Solver",
            message=f"Giải tối ưu thành công ({solver_status}) trong {elapsed_ms:.1f}ms.",
        )
