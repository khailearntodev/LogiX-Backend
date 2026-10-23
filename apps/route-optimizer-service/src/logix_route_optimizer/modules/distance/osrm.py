from __future__ import annotations

import logging
from typing import Any

import httpx

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

    def _format_coords(self, coordinates: list[tuple[float, float]]) -> str:
        """OSRM expects coordinates in `lon,lat` order separated by semicolons."""
        return ";".join(f"{lon:.6f},{lat:.6f}" for lat, lon in coordinates)

    async def get_table(
        self, coordinates: list[tuple[float, float]]
    ) -> tuple[list[list[float]], list[list[int]]] | None:
        """
        Query OSRM Table API for distance (meters) and duration (seconds) matrices.
        Input coordinates are list of (lat, lon).
        Returns (distances_matrix, durations_matrix) or None if request fails.
        """
        if len(coordinates) < 2:
            return [[0.0]], [[0]]

        coord_str = self._format_coords(coordinates)
        url = f"{self.base_url}/table/v1/driving/{coord_str}?annotations=distance,duration"

        try:
            if self._external_client:
                resp = await self._external_client.get(url, timeout=self.timeout_seconds)
            else:
                async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
                    resp = await client.get(url)

            if resp.status_code != 200:
                logger.warning(
                    "OSRM Table API returned status %d: %s", resp.status_code, resp.text[:200]
                )
                return None

            data = resp.json()
            if data.get("code") != "Ok":
                logger.warning("OSRM Table API returned non-Ok code: %s", data.get("code"))
                return None

            raw_distances = data.get("distances")
            raw_durations = data.get("durations")

            if not raw_distances or not raw_durations:
                return None

            # Convert to clean floats and ints
            distances: list[list[float]] = [
                [float(d or 0.0) for d in row] for row in raw_distances
            ]
            durations: list[list[int]] = [
                [int(round(float(s or 0.0))) for s in row] for row in raw_durations
            ]
            return distances, durations

        except Exception as exc:
            logger.warning("OSRM Table API call failed: %s", exc)
            return None

    async def get_route(
        self, coordinates: list[tuple[float, float]]
    ) -> dict[str, Any] | None:
        """
        Query OSRM Route API for driving polyline and leg details.
        Returns dict with total_distance_m, total_duration_s, geometry (list of [lng, lat]), legs.
        """
        if len(coordinates) < 2:
            return None

        coord_str = self._format_coords(coordinates)
        url = f"{self.base_url}/route/v1/driving/{coord_str}?overview=full&geometries=geojson&steps=false"

        try:
            if self._external_client:
                resp = await self._external_client.get(url, timeout=self.timeout_seconds)
            else:
                async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
                    resp = await client.get(url)

            if resp.status_code != 200:
                return None

            data = resp.json()
            if data.get("code") != "Ok" or not data.get("routes"):
                return None

            route = data["routes"][0]
            geometry = route.get("geometry", {}).get("coordinates", [])

            return {
                "distance_m": float(route.get("distance", 0.0)),
                "duration_s": int(round(float(route.get("duration", 0.0)))),
                "geometry": geometry,
                "legs": route.get("legs", []),
            }
        except Exception as exc:
            logger.warning("OSRM Route API call failed: %s", exc)
            return None
