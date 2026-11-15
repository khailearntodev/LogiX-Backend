from __future__ import annotations

import math

from logix_route_optimizer.modules.distance.vietnam_corridor import (
    build_vietnam_corridor_waypoints,
    needs_vietnam_coastal_corridor,
)

EARTH_RADIUS_METERS = 6371000.0
# Urban traffic average speed in TP.HCM ~28 km/h = 7.78 m/s
DEFAULT_URBAN_SPEED_KMH = 28.0
# Inter-regional highway average speed along QL1A / CT01 ~55 km/h
DEFAULT_HIGHWAY_SPEED_KMH = 55.0
# Typical road detour index over straight line (Manhattan / urban detour factor)
DEFAULT_DETOUR_FACTOR = 1.35
DEFAULT_CORRIDOR_DETOUR_FACTOR = 1.18


def haversine_distance_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Calculate the great circle distance between two points on the earth in meters."""
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)

    a = (
        math.sin(delta_phi / 2.0) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2.0) ** 2
    )
    c = 2.0 * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))
    return EARTH_RADIUS_METERS * c


def road_distance_estimate_m(
    lat1: float,
    lon1: float,
    lat2: float,
    lon2: float,
    detour_factor: float = DEFAULT_DETOUR_FACTOR,
) -> float:
    """
    Estimated street road distance based on Haversine distance and detour factor.
    When two points in Vietnam span across Central Vietnam's S-curve, routes along
    National Highway 1A waypoints so distance never cuts across Cambodia or Laos.
    """
    if needs_vietnam_coastal_corridor(lat1, lon1, lat2, lon2):
        waypoints = build_vietnam_corridor_waypoints(lat1, lon1, lat2, lon2)
        corridor_haversine = sum(
            haversine_distance_m(
                waypoints[k][0],
                waypoints[k][1],
                waypoints[k + 1][0],
                waypoints[k + 1][1],
            )
            for k in range(len(waypoints) - 1)
        )
        return corridor_haversine * DEFAULT_CORRIDOR_DETOUR_FACTOR

    return haversine_distance_m(lat1, lon1, lat2, lon2) * detour_factor


def estimate_duration_seconds(
    distance_m: float, speed_kmh: float = DEFAULT_URBAN_SPEED_KMH
) -> int:
    """Estimate duration in seconds based on distance in meters and speed in km/h."""
    speed_mps = (speed_kmh * 1000.0) / 3600.0
    if speed_mps <= 0:
        return 0
    return max(0, int(round(distance_m / speed_mps)))


class HaversineProvider:
    """Fail-safe fallback distance & duration calculator using Haversine formula."""

    provider_name: str = "HAVERSINE_FALLBACK"

    def compute_distance_and_duration(
        self, lat1: float, lon1: float, lat2: float, lon2: float
    ) -> tuple[float, int]:
        dist_m = road_distance_estimate_m(lat1, lon1, lat2, lon2)
        speed = (
            DEFAULT_HIGHWAY_SPEED_KMH
            if needs_vietnam_coastal_corridor(lat1, lon1, lat2, lon2)
            else DEFAULT_URBAN_SPEED_KMH
        )
        duration_s = estimate_duration_seconds(dist_m, speed_kmh=speed)
        return dist_m, duration_s

    def compute_matrix(
        self, coordinates: list[tuple[float, float]]
    ) -> tuple[list[list[float]], list[list[int]]]:
        """Compute square matrices of distance (meters) and duration (seconds) for coordinates (lat, lon)."""
        n = len(coordinates)
        distances = [[0.0] * n for _ in range(n)]
        durations = [[0] * n for _ in range(n)]

        for i in range(n):
            lat_i, lon_i = coordinates[i]
            for j in range(n):
                if i == j:
                    distances[i][j] = 0.0
                    durations[i][j] = 0
                else:
                    lat_j, lon_j = coordinates[j]
                    d_m, dur_s = self.compute_distance_and_duration(
                        lat_i, lon_i, lat_j, lon_j
                    )
                    distances[i][j] = d_m
                    durations[i][j] = dur_s

        return distances, durations
