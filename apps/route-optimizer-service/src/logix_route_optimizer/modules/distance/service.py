from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from logix_route_optimizer.config import settings
from logix_route_optimizer.modules.distance.haversine import (
    HaversineProvider,
    road_distance_estimate_m,
    estimate_duration_seconds,
)
from logix_route_optimizer.modules.distance.osrm import OSRMProvider


@dataclass(slots=True)
class DistanceMatrixResult:
    distances_m: list[list[float]]
    durations_s: list[list[int]]
    provider_name: str
    is_fallback: bool


@dataclass(slots=True)
class RouteGeometryResult:
    geometry_coords: list[list[float]]  # List of [lng, lat]
    total_distance_m: float
    total_duration_s: int
    legs: list[dict[str, Any]]
    provider_name: str


class ResilientDistanceService:
    """Distance service that queries OSRM first, with automatic Haversine fallback."""

    def __init__(
        self,
        osrm_provider: OSRMProvider | None = None,
        haversine_provider: HaversineProvider | None = None,
    ) -> None:
        self.osrm = osrm_provider or OSRMProvider(
            base_url=settings.osrm_url,
            timeout_seconds=settings.osrm_timeout_seconds,
        )
        self.haversine = haversine_provider or HaversineProvider()

    async def get_distance_and_duration_matrix(
        self, coordinates: list[tuple[float, float]]
    ) -> DistanceMatrixResult:
        """Fetch distance and duration square matrices for the given list of (lat, lon)."""
        osrm_table = await self.osrm.get_table(coordinates)
        if osrm_table is not None:
            distances, durations = osrm_table
            return DistanceMatrixResult(
                distances_m=distances,
                durations_s=durations,
                provider_name="OSRM Road Network Driving API",
                is_fallback=False,
            )

        # Fallback to Haversine
        distances, durations = self.haversine.compute_matrix(coordinates)
        return DistanceMatrixResult(
            distances_m=distances,
            durations_s=durations,
            provider_name="Haversine Distance (Fail-safe Fallback)",
            is_fallback=True,
        )

    async def get_route_geometry(
        self, ordered_coordinates: list[tuple[float, float]]
    ) -> RouteGeometryResult:
        """
        Get full road geometry (polyline) and leg distances for an ordered path of (lat, lon).
        """
        if len(ordered_coordinates) >= 2:
            osrm_route = await self.osrm.get_route(ordered_coordinates)
            if osrm_route is not None:
                return RouteGeometryResult(
                    geometry_coords=osrm_route.get("geometry", []),
                    total_distance_m=osrm_route.get("distance_m", 0.0),
                    total_duration_s=osrm_route.get("duration_s", 0),
                    legs=osrm_route.get("legs", []),
                    provider_name="OSRM Road Network Driving API",
                )

        # Fallback straight legs geometry
        total_dist_m = 0.0
        total_dur_s = 0
        legs: list[dict[str, Any]] = []
        straight_coords: list[list[float]] = []

        for i in range(len(ordered_coordinates)):
            lat, lon = ordered_coordinates[i]
            straight_coords.append([lon, lat])
            if i > 0:
                prev_lat, prev_lon = ordered_coordinates[i - 1]
                leg_dist = road_distance_estimate_m(prev_lat, prev_lon, lat, lon)
                leg_dur = estimate_duration_seconds(leg_dist)
                total_dist_m += leg_dist
                total_dur_s += leg_dur
                legs.append({"distance": leg_dist, "duration": leg_dur})

        return RouteGeometryResult(
            geometry_coords=straight_coords,
            total_distance_m=total_dist_m,
            total_duration_s=total_dur_s,
            legs=legs,
            provider_name="Haversine Straight-line Geometry (Fallback)",
        )
