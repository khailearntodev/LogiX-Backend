from __future__ import annotations

import hashlib
import json
import logging
import uuid
from decimal import Decimal
from typing import Any

from logix_route_optimizer.modules.distance.service import (
    ResilientDistanceService,
)
from logix_route_optimizer.modules.routing.checker import SolutionChecker
from logix_route_optimizer.modules.routing.defaults import (
    DEFAULT_DEPOT,
    DEFAULT_SAMPLE_STOPS,
    DEFAULT_VEHICLE,
)
from logix_route_optimizer.modules.routing.schemas import (
    ProposedRouteOut,
    RouteOptimizationRequest,
    StopDetailOut,
    StopIn,
)
from logix_route_optimizer.modules.routing.solver import ORToolsCVRPSolver

logger = logging.getLogger(__name__)


def _compute_input_hash(data: dict[str, Any]) -> str:
    serialized = json.dumps(data, sort_keys=True, default=str)
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


class RouteEngine:
    """Core engine responsible for computing routes, distances, durations, and baselines."""

    def __init__(
        self,
        distance_service: ResilientDistanceService | None = None,
        solver: ORToolsCVRPSolver | None = None,
    ) -> None:
        self.distance_service = distance_service or ResilientDistanceService()
        self.solver = solver or ORToolsCVRPSolver(time_limit_seconds=5)

    def _solve_nearest_neighbor(
        self, matrix: list[list[float]], n_stops: int
    ) -> list[int]:
        """
        Greedy Nearest Neighbor heuristic:
        Node 0 is depot. Stops are 1..n_stops.
        Returns ordered list of stop indices 1..n_stops.
        """
        unvisited = set(range(1, n_stops + 1))
        current = 0
        order: list[int] = []

        while unvisited:
            next_node = min(unvisited, key=lambda node: matrix[current][node])
            order.append(next_node)
            unvisited.remove(next_node)
            current = next_node

        return order

    def _calc_tour_distance(self, matrix: list[list[float]], tour_stop_indices: list[int]) -> float:
        """Calculate total distance of tour Depot -> Stop 1 -> ... -> Stop N -> Depot."""
        if not tour_stop_indices:
            return 0.0
        total = 0.0
        current = 0
        for next_node in tour_stop_indices:
            total += matrix[current][next_node]
            current = next_node
        total += matrix[current][0]  # Return to depot
        return total

    async def compute_route(self, request: RouteOptimizationRequest) -> ProposedRouteOut:
        trip_id = request.trip_id or uuid.uuid4()
        route_plan_id = uuid.uuid4()
        depot = request.depot or DEFAULT_DEPOT
        stops: list[StopIn] = list(request.stops or DEFAULT_SAMPLE_STOPS)
        vehicle = request.vehicle or DEFAULT_VEHICLE

        # Check vehicle capacity constraints
        total_demand_weight = float(sum(Decimal(str(s.demand_weight_kg)) for s in stops))
        total_demand_volume = float(sum(Decimal(str(s.demand_volume_m3)) for s in stops))

        feasibility_status = "FEASIBLE"
        feasibility_note = "Tải trọng và thể tích xe đáp ứng tốt toàn bộ đơn hàng."
        is_overcapacity = (
            total_demand_weight > vehicle.capacity_weight_kg
            or total_demand_volume > vehicle.capacity_volume_m3
        )
        if is_overcapacity:
            feasibility_status = "INFEASIBLE"
            feasibility_note = (
                f"CẢNH BÁO: Quá tải! Tổng trọng lượng ({total_demand_weight:.1f}kg/{vehicle.capacity_weight_kg:.1f}kg) "
                f"hoặc thể tích ({total_demand_volume:.2f}m3/{vehicle.capacity_volume_m3:.2f}m3) vượt sức chứa xe."
            )

        # Coordinate list: index 0 is depot, indices 1..N are stops
        all_coords = [(depot.lat, depot.lng)] + [(s.lat, s.lng) for s in stops]

        # 1. Fetch distance and duration matrices
        matrix_result = await self.distance_service.get_distance_and_duration_matrix(all_coords)
        dist_matrix = matrix_result.distances_m
        dur_matrix = matrix_result.durations_s

        n_stops = len(stops)

        # Baselines:
        # 1. Sequential route order: 1, 2, ..., n_stops (Input Order)
        seq_indices = list(range(1, n_stops + 1))
        sequential_dist_m = self._calc_tour_distance(dist_matrix, seq_indices)

        # 2. Nearest Neighbor order
        nn_indices = self._solve_nearest_neighbor(dist_matrix, n_stops)
        nn_dist_m = self._calc_tour_distance(dist_matrix, nn_indices)

        # 3. Solve with Google OR-Tools CVRP Solver
        demand_weights = [0.0] + [s.demand_weight_kg for s in stops]
        demand_volumes = [0.0] + [s.demand_volume_m3 for s in stops]

        solver_result = self.solver.solve(
            distance_matrix_m=dist_matrix,
            demand_weights_kg=demand_weights,
            demand_volumes_m3=demand_volumes,
            capacity_weight_kg=vehicle.capacity_weight_kg,
            capacity_volume_m3=vehicle.capacity_volume_m3,
        )

        chosen_indices: list[int]
        total_distance_m: float
        solver_method: str

        if solver_result.status in ("OPTIMAL", "FEASIBLE") and solver_result.ordered_stop_indices:
            check_report = SolutionChecker.check_solution(
                ordered_stop_indices=solver_result.ordered_stop_indices,
                num_stops=n_stops,
                distance_matrix_m=dist_matrix,
                demand_weights_kg=demand_weights,
                demand_volumes_m3=demand_volumes,
                capacity_weight_kg=vehicle.capacity_weight_kg,
                capacity_volume_m3=vehicle.capacity_volume_m3,
            )
            if check_report.is_valid:
                chosen_indices = solver_result.ordered_stop_indices
                total_distance_m = solver_result.total_distance_m
                solver_method = f"Google OR-Tools CVRP ({solver_result.status})"
            else:
                logger.warning("SolutionChecker reported violations: %s; falling back to Nearest Neighbor", check_report.violations)
                chosen_indices = nn_indices
                total_distance_m = nn_dist_m
                solver_method = "Fallback Nearest Neighbor (Check Failed)"
        elif is_overcapacity:
            chosen_indices = nn_indices
            total_distance_m = nn_dist_m
            solver_method = "Google OR-Tools CVRP (Infeasible Overcapacity)"
        else:
            logger.warning("OR-Tools solver status %s; falling back to Nearest Neighbor", solver_result.status)
            chosen_indices = nn_indices
            total_distance_m = nn_dist_m
            solver_method = "Fallback Nearest Neighbor"

        # 2. Build stop details with leg distances
        stop_details: list[StopDetailOut] = []
        cumulative_duration_s = 0
        prev_idx = 0

        for new_seq, idx in enumerate(chosen_indices, start=1):
            stop_model = stops[idx - 1]
            leg_distance_m = dist_matrix[prev_idx][idx]
            leg_duration_s = dur_matrix[prev_idx][idx]
            cumulative_duration_s += leg_duration_s

            stop_details.append(
                StopDetailOut(
                    trip_stop_id=stop_model.trip_stop_id,
                    sequence=new_seq,
                    stop_name=stop_model.stop_name,
                    address=stop_model.address,
                    lat=stop_model.lat,
                    lng=stop_model.lng,
                    demand_weight_kg=stop_model.demand_weight_kg,
                    demand_volume_m3=stop_model.demand_volume_m3,
                    distance_from_prev_km=round(leg_distance_m / 1000.0, 2),
                    estimated_duration_minutes=max(1, int(round(leg_duration_s / 60.0))),
                )
            )
            prev_idx = idx

        # Return to depot leg duration
        cumulative_duration_s += dur_matrix[prev_idx][0]

        # 3. Get full road geometry for the tour: Depot -> Stops -> Depot
        path_coords = (
            [(depot.lat, depot.lng)]
            + [(stops[i - 1].lat, stops[i - 1].lng) for i in chosen_indices]
            + [(depot.lat, depot.lng)]
        )
        geom_result = await self.distance_service.get_route_geometry(path_coords)

        # Convert meters to km
        total_distance_km = round(total_distance_m / 1000.0, 2)
        total_duration_minutes = max(1, int(round(cumulative_duration_s / 60.0)))
        baseline_input_order_km = round(sequential_dist_m / 1000.0, 2)
        baseline_nearest_neighbor_km = round(nn_dist_m / 1000.0, 2)

        # Comparison savings relative to input order baseline
        if baseline_input_order_km > 0 and total_distance_km < baseline_input_order_km:
            distance_saved_km = round(baseline_input_order_km - total_distance_km, 2)
            improvement_ratio_percent = round((distance_saved_km / baseline_input_order_km) * 100.0, 2)
        else:
            distance_saved_km = 0.0
            improvement_ratio_percent = 0.0

        savings_note = (
            f"Tiết kiệm {distance_saved_km} km ({improvement_ratio_percent}%) so với thứ tự ban đầu."
            if distance_saved_km > 0
            else "Tuyến đường đã đạt mức tối ưu."
        )

        recommended_action = (
            f"Lộ trình {n_stops} điểm dừng đã được tối ưu hóa bằng {solver_method} "
            f"({total_distance_km} km, khoảng {total_duration_minutes} phút). {savings_note} "
            f"{feasibility_note} Vui lòng phê duyệt để chuyến xe có thể dispatch."
        )

        return ProposedRouteOut(
            trip_id=trip_id,
            route_plan_id=route_plan_id,
            depot_name=depot.name,
            depot_address=depot.address,
            depot_lat=depot.lat,
            depot_lng=depot.lng,
            total_distance_km=total_distance_km,
            total_duration_minutes=total_duration_minutes,
            baseline_input_order_km=baseline_input_order_km,
            baseline_nearest_neighbor_km=baseline_nearest_neighbor_km,
            distance_saved_km=distance_saved_km,
            improvement_ratio_percent=improvement_ratio_percent,
            vehicle_capacity_weight_kg=vehicle.capacity_weight_kg,
            total_demand_weight_kg=total_demand_weight,
            vehicle_capacity_volume_m3=vehicle.capacity_volume_m3,
            total_demand_volume_m3=total_demand_volume,
            feasibility_status=feasibility_status,
            solver_method=solver_method,
            distance_provider=matrix_result.provider_name,
            stops=stop_details,
            recommended_action=recommended_action,
            polyline=geom_result.geometry_coords,
            legs=geom_result.legs,
        )
