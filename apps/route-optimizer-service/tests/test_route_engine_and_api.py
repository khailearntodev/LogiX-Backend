from __future__ import annotations

import uuid
import pytest
from httpx import ASGITransport, AsyncClient

from logix_route_optimizer.main import app
from logix_route_optimizer.modules.distance.haversine import (
    HaversineProvider,
    haversine_distance_m,
    estimate_duration_seconds,
)
from logix_route_optimizer.modules.distance.service import ResilientDistanceService
from logix_route_optimizer.modules.routing.engine import RouteEngine
from logix_route_optimizer.modules.routing.schemas import (
    LocationIn,
    RouteOptimizationRequest,
    StopIn,
    VehicleIn,
)


def test_haversine_distance_calculation() -> None:
    # Distance between Tan Binh depot and Quan 1 (approx 5-7 km)
    depot_lat, depot_lng = 10.8015, 106.6542
    q1_lat, q1_lng = 10.7769, 106.7009

    dist_m = haversine_distance_m(depot_lat, depot_lng, q1_lat, q1_lng)
    assert 5000 <= dist_m <= 7000

    duration_s = estimate_duration_seconds(dist_m, speed_kmh=30.0)
    assert duration_s > 0


@pytest.mark.asyncio
async def test_resilient_distance_service_matrix() -> None:
    provider = HaversineProvider()
    service = ResilientDistanceService(haversine_provider=provider)

    coords = [(10.8015, 106.6542), (10.7725, 106.6690), (10.7812, 106.6845)]
    matrix_res = await service.get_distance_and_duration_matrix(coords)

    assert len(matrix_res.distances_m) == 3
    assert len(matrix_res.durations_s) == 3
    assert matrix_res.distances_m[0][0] == 0.0
    assert matrix_res.distances_m[0][1] > 0.0


@pytest.mark.asyncio
async def test_route_engine_computes_sequential_route() -> None:
    engine = RouteEngine()
    req = RouteOptimizationRequest(
        depot=LocationIn(name="Kho Test", address="123 Test St", lat=10.8015, lng=106.6542),
        vehicle=VehicleIn(capacity_weight_kg=1000.0, capacity_volume_m3=10.0),
        stops=[
            StopIn(
                trip_stop_id=uuid.uuid4(),
                stop_name="Điểm 1",
                address="Quận 10",
                lat=10.7725,
                lng=106.6690,
                demand_weight_kg=100.0,
                demand_volume_m3=1.0,
            ),
            StopIn(
                trip_stop_id=uuid.uuid4(),
                stop_name="Điểm 2",
                address="Quận 1",
                lat=10.7769,
                lng=106.7009,
                demand_weight_kg=200.0,
                demand_volume_m3=2.0,
            ),
        ],
    )
    result = await engine.compute_route(req)

    assert result.total_distance_km > 0
    assert result.total_duration_minutes > 0
    assert result.feasibility_status == "FEASIBLE"
    assert len(result.stops) == 2
    assert result.stops[0].sequence == 1
    assert result.stops[1].sequence == 2
    assert result.total_demand_weight_kg == 300.0
    assert result.total_demand_volume_m3 == 3.0


@pytest.mark.asyncio
async def test_route_engine_detects_overcapacity() -> None:
    engine = RouteEngine()
    req = RouteOptimizationRequest(
        vehicle=VehicleIn(capacity_weight_kg=50.0, capacity_volume_m3=1.0),
        stops=[
            StopIn(
                stop_name="Nặng quá tải",
                lat=10.7725,
                lng=106.6690,
                demand_weight_kg=500.0,
                demand_volume_m3=5.0,
            )
        ],
    )
    result = await engine.compute_route(req)
    assert result.feasibility_status == "INFEASIBLE"
    assert "Quá tải" in result.recommended_action


@pytest.mark.asyncio
async def test_api_post_route_optimization_endpoint() -> None:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # 1. Post request with default sample stops
        resp = await client.post(
            "/api/v1/route-optimizations",
            json={"trip_id": str(uuid.uuid4())},
        )
        assert resp.status_code == 200
        data = resp.json()

        assert "total_distance_km" in data
        assert "total_duration_minutes" in data
        assert "stops" in data
        assert len(data["stops"]) == 5
        assert data["feasibility_status"] == "FEASIBLE"
        assert "OSRM" in data["distance_provider"] or "Haversine" in data["distance_provider"]


@pytest.mark.asyncio
async def test_api_get_sample_route_endpoint() -> None:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/api/v1/route-optimizations/sample")
        assert resp.status_code == 200
        data = resp.json()
        assert data["depot_name"] == "Kho Tổng Miền Nam (Tân Bình)"
        assert len(data["stops"]) == 5


@pytest.mark.asyncio
async def test_api_get_route_by_run_id() -> None:
    trip_id = uuid.uuid4()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get(f"/api/v1/route-optimizations/{trip_id}")
        assert resp.status_code == 200
        data = resp.json()
        assert data["trip_id"] == str(trip_id)
