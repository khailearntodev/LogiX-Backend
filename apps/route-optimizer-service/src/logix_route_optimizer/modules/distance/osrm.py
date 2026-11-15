from __future__ import annotations

import logging
from typing import Any

import httpx

from logix_route_optimizer.modules.distance.haversine import HaversineProvider
from logix_route_optimizer.modules.distance.vietnam_corridor import (
    build_vietnam_corridor_waypoints,
    is_geojson_polyline_in_vietnam,
    is_point_in_vietnam_corridor,
    needs_vietnam_coastal_corridor,
)

logger = logging.getLogger(__name__)


class OSRMProvider:
    """Primary distance and route geometry provider querying Open Source Routing Machine (OSRM)."""

    provider_name: str = "OSRM_DRIVING"

    def __init__(
        self,
        base_url: str = "https://router.project-osrm.org",
        timeout_seconds: float = 4.0,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout_seconds = timeout_seconds
        self._external_client = client
        self._corridor_fallback = HaversineProvider()

    def _format_coords(self, coordinates: list[tuple[float, float]]) -> str:
        """OSRM expects coordinates in `lon,lat` order separated by semicolons."""
        return ";".join(f"{lon:.6f},{lat:.6f}" for lat, lon in coordinates)

    async def _get_json(self, url: str) -> dict[str, Any] | None:
        try:
            if self._external_client:
                resp = await self._external_client.get(url, timeout=self.timeout_seconds)
            else:
                async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
                    resp = await client.get(url)

            if resp.status_code != 200:
                logger.warning(
                    "OSRM API returned status %d: %s", resp.status_code, resp.text[:200]
                )
                return None

            data = resp.json()
            if data.get("code") != "Ok":
                logger.warning("OSRM API returned non-Ok code: %s", data.get("code"))
                return None
            return data
        except Exception as exc:
            logger.warning("OSRM API call failed: %s", exc)
            return None

    async def get_table(
        self, coordinates: list[tuple[float, float]]
    ) -> tuple[list[list[float]], list[list[int]]] | None:
        """
        Query OSRM Table API for distance (meters) and duration (seconds) matrices.
        Input coordinates are list of (lat, lon).
        For domestic Vietnam pairs that span across the Central Vietnam S-curve,
        enforces the National Highway 1A corridor so distances never shortcut through Cambodia or Laos.
        """
        if len(coordinates) < 2:
            return [[0.0]], [[0]]

        coord_str = self._format_coords(coordinates)
        url = f"{self.base_url}/table/v1/driving/{coord_str}?annotations=distance,duration"
        data = await self._get_json(url)
        if data is None:
            return None

        raw_distances = data.get("distances")
        raw_durations = data.get("durations")
        if not raw_distances or not raw_durations:
            return None

        distances: list[list[float]] = [
            [float(d or 0.0) for d in row] for row in raw_distances
        ]
        durations: list[list[int]] = [
            [int(round(float(s or 0.0))) for s in row] for row in raw_durations
        ]

        n = len(coordinates)
        for i in range(n):
            lat_i, lon_i = coordinates[i]
            for j in range(n):
                if i == j:
                    continue
                lat_j, lon_j = coordinates[j]
                if needs_vietnam_coastal_corridor(lat_i, lon_i, lat_j, lon_j):
                    corridor_dist_m, corridor_dur_s = (
                        self._corridor_fallback.compute_distance_and_duration(
                            lat_i, lon_i, lat_j, lon_j
                        )
                    )
                    distances[i][j] = corridor_dist_m
                    durations[i][j] = corridor_dur_s

        return distances, durations

    async def _fetch_raw_route(
        self, coordinates: list[tuple[float, float]]
    ) -> dict[str, Any] | None:
        if len(coordinates) < 2:
            return None

        coord_str = self._format_coords(coordinates)
        url = f"{self.base_url}/route/v1/driving/{coord_str}?overview=full&geometries=geojson&steps=false"
        data = await self._get_json(url)
        if data is None or not data.get("routes"):
            return None

        route = data["routes"][0]
        geometry = route.get("geometry", {}).get("coordinates", [])

        return {
            "distance_m": float(route.get("distance", 0.0)),
            "duration_s": int(round(float(route.get("duration", 0.0)))),
            "geometry": geometry,
            "legs": route.get("legs", []),
        }

    async def get_route(
        self, coordinates: list[tuple[float, float]]
    ) -> dict[str, Any] | None:
        """
        Query OSRM Route API for driving polyline and leg details.
        Ensures routes between domestic Vietnam stops stay strictly within Vietnam's territory
        (never crossing into Cambodia, Laos, or China).
        """
        if len(coordinates) < 2:
            return None

        all_in_vietnam = all(
            is_point_in_vietnam_corridor(lat, lon) for lat, lon in coordinates
        )
        any_cross_region_leg = any(
            needs_vietnam_coastal_corridor(
                coordinates[i][0],
                coordinates[i][1],
                coordinates[i + 1][0],
                coordinates[i + 1][1],
            )
            for i in range(len(coordinates) - 1)
        )

        if not any_cross_region_leg:
            direct = await self._fetch_raw_route(coordinates)
            if direct is None:
                return None
            if not all_in_vietnam or is_geojson_polyline_in_vietnam(direct["geometry"]):
                return direct

        # Route leg-by-leg using Vietnam QL1A corridor waypoints where needed
        merged_geometry: list[list[float]] = []
        merged_legs: list[dict[str, Any]] = []
        total_distance_m = 0.0
        total_duration_s = 0

        for i in range(len(coordinates) - 1):
            start_lat, start_lon = coordinates[i]
            end_lat, end_lon = coordinates[i + 1]
            waypoints = build_vietnam_corridor_waypoints(
                start_lat, start_lon, end_lat, end_lon
            )
            leg_route = await self._fetch_raw_route(waypoints)

            if (
                leg_route is not None
                and leg_route.get("geometry")
                and (
                    not all_in_vietnam
                    or is_geojson_polyline_in_vietnam(leg_route["geometry"])
                )
            ):
                leg_geom = leg_route["geometry"]
                leg_dist = float(leg_route["distance_m"])
                leg_dur = int(leg_route["duration_s"])
            else:
                # Domestic corridor fallback along QL1A waypoints so geometry never crosses borders
                leg_geom = [[lon, lat] for lat, lon in waypoints]
                leg_dist, leg_dur = (
                    self._corridor_fallback.compute_distance_and_duration(
                        start_lat, start_lon, end_lat, end_lon
                    )
                )

            if merged_geometry and leg_geom:
                merged_geometry.extend(leg_geom[1:])
            else:
                merged_geometry.extend(leg_geom)

            total_distance_m += leg_dist
            total_duration_s += leg_dur
            merged_legs.append({"distance": leg_dist, "duration": leg_dur})

        return {
            "distance_m": total_distance_m,
            "duration_s": total_duration_s,
            "geometry": merged_geometry,
            "legs": merged_legs,
        }
