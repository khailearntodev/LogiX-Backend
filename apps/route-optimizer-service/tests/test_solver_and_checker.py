from __future__ import annotations

import pytest

from logix_route_optimizer.modules.routing.checker import SolutionChecker
from logix_route_optimizer.modules.routing.solver import ORToolsCVRPSolver


def test_ortools_cvrp_solver_finds_optimal_tour() -> None:
    # 3-stop symmetric triangle with depot at 0
    # Depot (0), Stop 1 (1), Stop 2 (2)
    # 0 -> 1: 10m, 1 -> 2: 10m, 2 -> 0: 10m (tour 0-1-2-0 = 30m)
    # Direct 0 -> 2: 25m, 0 -> 1: 10m, 1 -> 2: 10m
    dist_matrix = [
        [0.0, 10.0, 25.0],
        [10.0, 0.0, 10.0],
        [25.0, 10.0, 0.0],
    ]
    weights = [0.0, 100.0, 100.0]
    volumes = [0.0, 1.0, 1.0]

    solver = ORToolsCVRPSolver(time_limit_seconds=3)
    result = solver.solve(
        distance_matrix_m=dist_matrix,
        demand_weights_kg=weights,
        demand_volumes_m3=volumes,
        capacity_weight_kg=500.0,
        capacity_volume_m3=5.0,
    )

    assert result.status in ("OPTIMAL", "FEASIBLE")
    assert set(result.ordered_stop_indices) == {1, 2}
    # Optimal tour is 0 -> 1 -> 2 -> 0 (10 + 10 + 25 = 45m) or 0 -> 2 -> 1 -> 0 (25 + 10 + 10 = 45m)
    assert result.total_distance_m == 45.0
    assert result.solver_latency_ms >= 0


def test_ortools_cvrp_detects_overcapacity() -> None:
    dist_matrix = [
        [0.0, 10.0, 20.0],
        [10.0, 0.0, 15.0],
        [20.0, 15.0, 0.0],
    ]
    # Total weight 600kg > capacity 500kg
    weights = [0.0, 300.0, 300.0]
    volumes = [0.0, 1.0, 1.0]

    solver = ORToolsCVRPSolver(time_limit_seconds=2)
    result = solver.solve(
        distance_matrix_m=dist_matrix,
        demand_weights_kg=weights,
        demand_volumes_m3=volumes,
        capacity_weight_kg=500.0,
        capacity_volume_m3=5.0,
    )

    assert result.status == "INFEASIBLE"
    assert "vượt quá sức chứa" in result.message


def test_solution_checker_validates_solution() -> None:
    dist_matrix = [
        [0.0, 10.0, 20.0],
        [10.0, 0.0, 15.0],
        [20.0, 15.0, 0.0],
    ]
    weights = [0.0, 100.0, 150.0]
    volumes = [0.0, 1.0, 1.5]

    # Valid solution
    report = SolutionChecker.check_solution(
        ordered_stop_indices=[1, 2],
        num_stops=2,
        distance_matrix_m=dist_matrix,
        demand_weights_kg=weights,
        demand_volumes_m3=volumes,
        capacity_weight_kg=500.0,
        capacity_volume_m3=5.0,
    )
    assert report.is_valid is True
    assert report.is_permutation_valid is True
    assert report.is_capacity_valid is True
    assert report.recalculated_distance_m == 10.0 + 15.0 + 20.0  # 0->1->2->0

    # Invalid permutation: missing stop 2, duplicate stop 1
    invalid_report = SolutionChecker.check_solution(
        ordered_stop_indices=[1, 1],
        num_stops=2,
        distance_matrix_m=dist_matrix,
        demand_weights_kg=weights,
        demand_volumes_m3=volumes,
        capacity_weight_kg=500.0,
        capacity_volume_m3=5.0,
    )
    assert invalid_report.is_valid is False
    assert invalid_report.is_permutation_valid is False
    assert len(invalid_report.violations) > 0


def test_solution_checker_detects_capacity_violations() -> None:
    dist_matrix = [
        [0.0, 10.0],
        [10.0, 0.0],
    ]
    weights = [0.0, 800.0]
    volumes = [0.0, 6.0]

    report = SolutionChecker.check_solution(
        ordered_stop_indices=[1],
        num_stops=1,
        distance_matrix_m=dist_matrix,
        demand_weights_kg=weights,
        demand_volumes_m3=volumes,
        capacity_weight_kg=500.0,
        capacity_volume_m3=5.0,
    )
    assert report.is_valid is False
    assert report.is_capacity_valid is False
    assert any("Quá tải trọng" in v for v in report.violations)
    assert any("Quá thể tích" in v for v in report.violations)
