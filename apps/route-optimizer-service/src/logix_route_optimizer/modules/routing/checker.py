from __future__ import annotations

from dataclasses import dataclass


@dataclass
class CheckReport:
    is_valid: bool
    is_capacity_valid: bool
    is_permutation_valid: bool
    recalculated_distance_m: float
    violations: list[str]


class SolutionChecker:
    """
    Independent validator for route optimization solutions.
    Ensures mathematical feasibility:
    - Every stop is visited exactly once (permutation of 1..N).
    - Cumulative demand does not exceed vehicle weight/volume capacities.
    - Tour starts and ends at Depot (node 0).
    """

    @staticmethod
    def check_solution(
        ordered_stop_indices: list[int],
        num_stops: int,
        distance_matrix_m: list[list[float]],
        demand_weights_kg: list[float],
        demand_volumes_m3: list[float],
        capacity_weight_kg: float,
        capacity_volume_m3: float,
    ) -> CheckReport:
        violations: list[str] = []

        # 1. Permutation check
        expected_set = set(range(1, num_stops + 1))
        actual_set = set(ordered_stop_indices)

        is_permutation_valid = True
        if len(ordered_stop_indices) != num_stops:
            violations.append(
                f"Số lượng điểm dừng không khớp: mong đợi {num_stops}, thực tế {len(ordered_stop_indices)}."
            )
            is_permutation_valid = False

        if actual_set != expected_set:
            missing = expected_set - actual_set
            extra = actual_set - expected_set
            if missing:
                violations.append(f"Thiếu các điểm dừng: {sorted(missing)}.")
            if extra:
                violations.append(f"Thừa hoặc sai các điểm dừng: {sorted(extra)}.")
            is_permutation_valid = False

        # 2. Capacity check
        total_weight = sum(demand_weights_kg[1:])
        total_volume = sum(demand_volumes_m3[1:])
        is_capacity_valid = True

        if total_weight > capacity_weight_kg:
            violations.append(
                f"Quá tải trọng: tổng {total_weight:.1f}kg > sức chứa {capacity_weight_kg:.1f}kg."
            )
            is_capacity_valid = False

        if total_volume > capacity_volume_m3:
            violations.append(
                f"Quá thể tích: tổng {total_volume:.2f}m3 > sức chứa {capacity_volume_m3:.2f}m3."
            )
            is_capacity_valid = False

        # 3. Recalculate tour distance Depot -> Stops -> Depot
        recalculated_dist = 0.0
        if is_permutation_valid and num_stops > 0:
            current = 0
            for stop_idx in ordered_stop_indices:
                recalculated_dist += distance_matrix_m[current][stop_idx]
                current = stop_idx
            recalculated_dist += distance_matrix_m[current][0]

        is_valid = is_permutation_valid and is_capacity_valid

        return CheckReport(
            is_valid=is_valid,
            is_capacity_valid=is_capacity_valid,
            is_permutation_valid=is_permutation_valid,
            recalculated_distance_m=recalculated_dist,
            violations=violations,
        )
