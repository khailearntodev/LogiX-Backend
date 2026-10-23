"""Unit tests for Route Optimizer tools and Sensitive Approval."""

from __future__ import annotations

import uuid

import httpx
import pytest

from logix_agent.modules.auth import Actor
from logix_agent.modules.registry import (
    RiskLevel,
    ToolContext,
)
from logix_agent.modules.tools.catalog import build_tool_registry
from logix_agent.modules.tools.catalog.route import (
    APPROVE_ROUTE,
    OPTIMIZE_ROUTE,
    READ_ROUTE,
    ApproveRouteIn,
    GetRouteComparisonIn,
    ProposedRouteOut,
    ProposeRouteIn,
    RouteComparisonOut,
)
from logix_agent.modules.tools.http_client import ServiceClient


def _sample_payload(trip_id: uuid.UUID) -> dict:
    return {
        "trip_id": str(trip_id),
        "route_plan_id": str(uuid.uuid4()),
        "depot_name": "Kho Tổng Miền Nam (Tân Bình)",
        "depot_address": "32 Phan Thúc Duyện, Phường 4, Quận Tân Bình, TP.HCM",
        "depot_lat": 10.8015,
        "depot_lng": 106.6542,
        "total_distance_km": 21.2,
        "total_duration_minutes": 52,
        "baseline_input_order_km": 28.4,
        "baseline_nearest_neighbor_km": 24.1,
        "distance_saved_km": 7.2,
        "improvement_ratio_percent": 25.35,
        "vehicle_capacity_weight_kg": 1000.0,
        "total_demand_weight_kg": 850.0,
        "vehicle_capacity_volume_m3": 8.0,
        "total_demand_volume_m3": 6.3,
        "feasibility_status": "FEASIBLE",
        "solver_method": "Sequential Road Route Provider",
        "distance_provider": "OSRM Road Network Driving API",
        "stops": [
            {
                "trip_stop_id": str(uuid.uuid4()),
                "sequence": 1,
                "stop_name": "Đại lý Minh Khai",
                "address": "120 Lý Thường Kiệt, Phường 7, Quận 10, TP.HCM",
                "lat": 10.7725,
                "lng": 106.6690,
                "demand_weight_kg": 150.0,
                "demand_volume_m3": 1.2,
                "distance_from_prev_km": 4.2,
                "estimated_duration_minutes": 12,
            },
            {
                "trip_stop_id": str(uuid.uuid4()),
                "sequence": 2,
                "stop_name": "Cửa hàng Bách Hóa Xanh",
                "address": "45 Trương Định, Phường 6, Quận 3, TP.HCM",
                "lat": 10.7812,
                "lng": 106.6845,
                "demand_weight_kg": 200.0,
                "demand_volume_m3": 1.5,
                "distance_from_prev_km": 2.1,
                "estimated_duration_minutes": 8,
            },
            {
                "trip_stop_id": str(uuid.uuid4()),
                "sequence": 3,
                "stop_name": "Siêu thị Mini Mart",
                "address": "88 Nguyễn Du, Phường Bến Nghé, Quận 1, TP.HCM",
                "lat": 10.7769,
                "lng": 106.7009,
                "demand_weight_kg": 180.0,
                "demand_volume_m3": 1.0,
                "distance_from_prev_km": 2.4,
                "estimated_duration_minutes": 9,
            },
            {
                "trip_stop_id": str(uuid.uuid4()),
                "sequence": 4,
                "stop_name": "Đại lý Hàng Tiêu Dùng",
                "address": "19 Bạch Đằng, Phường 24, Quận Bình Thạnh, TP.HCM",
                "lat": 10.8030,
                "lng": 106.7112,
                "demand_weight_kg": 220.0,
                "demand_volume_m3": 1.8,
                "distance_from_prev_km": 4.8,
                "estimated_duration_minutes": 14,
            },
            {
                "trip_stop_id": str(uuid.uuid4()),
                "sequence": 5,
                "stop_name": "Cửa hàng Tiện Lợi Phú Nhuận",
                "address": "105 Phan Xích Long, Phường 2, Quận Phú Nhuận, TP.HCM",
                "lat": 10.7985,
                "lng": 106.6810,
                "demand_weight_kg": 100.0,
                "demand_volume_m3": 0.8,
                "distance_from_prev_km": 3.5,
                "estimated_duration_minutes": 10,
            },
        ],
        "recommended_action": "Lộ trình đã được lập thành công.",
    }


def _ctx(*permissions: str) -> ToolContext:
    actor = Actor(
        user_id="u-dispatcher-1",
        tenant_id="t-logix-1",
        permissions=frozenset(permissions),
        access_token="test-token",
    )
    return ToolContext(actor=actor, correlation_id="c-route-1")


def _registry(trip_id: uuid.UUID | None = None) -> build_tool_registry:
    target_trip_id = trip_id or uuid.uuid4()

    def _handler(req: httpx.Request) -> httpx.Response:
        url_str = str(req.url)
        if "approve-route" in url_str:
            return httpx.Response(
                200,
                json={
                    "trip_id": str(target_trip_id),
                    "route_plan_id": str(uuid.uuid4()),
                    "status": "APPROVED",
                    "approved_at": "2026-10-21T12:00:00Z",
                    "message": "Phương án lộ trình giao hàng đã được phê duyệt thành công.",
                },
            )
        if "route-optimizations" in url_str:
            return httpx.Response(200, json=_sample_payload(target_trip_id))
        return httpx.Response(200, json={})

    client = ServiceClient(
        base_urls={
            "inventory": "http://inventory.test",
            "master_data": "http://master.test",
            "order": "http://order.test",
            "fulfillment": "http://fulfillment.test",
            "route_optimizer": "http://route-optimizer.test",
            "transport": "http://transport.test",
        },
        backoff_seconds=0,
        transport=httpx.MockTransport(_handler),
    )
    return build_tool_registry(client)



def test_route_tools_are_registered_with_correct_metadata() -> None:
    registry = _registry()
    ctx = _ctx(OPTIMIZE_ROUTE, READ_ROUTE, APPROVE_ROUTE)
    specs = {s.name: s for s in registry.list_for(ctx.actor)}

    assert "propose_trip_route" in specs
    assert "get_route_plan_comparison" in specs
    assert "approve_trip_route" in specs

    propose_spec = specs["propose_trip_route"]
    assert propose_spec.risk_level is RiskLevel.READ
    assert propose_spec.required_permission == OPTIMIZE_ROUTE
    assert propose_spec.target_service == "route_optimizer"

    comp_spec = specs["get_route_plan_comparison"]
    assert comp_spec.risk_level is RiskLevel.READ
    assert comp_spec.required_permission == READ_ROUTE

    approve_spec = specs["approve_trip_route"]
    assert approve_spec.risk_level is RiskLevel.WRITE
    assert approve_spec.is_sensitive is True
    assert approve_spec.preview is not None
    assert approve_spec.required_permission == APPROVE_ROUTE
    assert approve_spec.target_service == "transport"


def test_route_tools_permission_filtering() -> None:
    registry = _registry()

    # Actor without route permissions
    unauthorized_ctx = _ctx()
    names_unauth = {s.name for s in registry.list_for(unauthorized_ctx.actor)}
    assert "propose_trip_route" not in names_unauth
    assert "get_route_plan_comparison" not in names_unauth
    assert "approve_trip_route" not in names_unauth

    # Actor with optimize permission only
    opt_ctx = _ctx(OPTIMIZE_ROUTE)
    names_opt = {s.name for s in registry.list_for(opt_ctx.actor)}
    assert "propose_trip_route" in names_opt
    assert "approve_trip_route" not in names_opt

    # Actor with approve permission only
    appr_ctx = _ctx(APPROVE_ROUTE)
    names_appr = {s.name for s in registry.list_for(appr_ctx.actor)}
    assert "approve_trip_route" in names_appr
    assert "propose_trip_route" not in names_appr


@pytest.mark.asyncio
async def test_propose_trip_route_output_validation() -> None:
    trip_id = uuid.uuid4()
    registry = _registry(trip_id)
    ctx = _ctx(OPTIMIZE_ROUTE)
    spec = registry.get("propose_trip_route")

    args = ProposeRouteIn(trip_id=trip_id)
    result = await spec.handler(ctx, args)

    assert isinstance(result, ProposedRouteOut)
    assert result.trip_id == trip_id
    assert result.total_distance_km == 21.2
    assert result.baseline_input_order_km == 28.4
    assert result.distance_saved_km == 7.2
    assert result.improvement_ratio_percent == 25.35
    assert result.feasibility_status == "FEASIBLE"
    assert "OSRM" in result.distance_provider
    assert "Road" in result.solver_method or "Sequential" in result.solver_method
    assert len(result.stops) == 5
    assert result.stops[0].sequence == 1
    assert result.stops[4].sequence == 5
    assert result.total_demand_weight_kg == 850.0
    assert result.vehicle_capacity_weight_kg == 1000.0


@pytest.mark.asyncio
async def test_get_route_plan_comparison() -> None:
    trip_id = uuid.uuid4()
    registry = _registry(trip_id)
    ctx = _ctx(READ_ROUTE)
    spec = registry.get("get_route_plan_comparison")

    args = GetRouteComparisonIn(trip_id=trip_id)
    result = await spec.handler(ctx, args)

    assert isinstance(result, RouteComparisonOut)
    assert result.trip_id == trip_id
    assert result.optimal_distance_km == 21.2
    assert result.baseline_input_order_km == 28.4
    assert result.improvement_vs_input_order_percent == 25.35
    assert len(result.methods) == 3


@pytest.mark.asyncio
async def test_approve_trip_route_preview_and_handler() -> None:
    trip_id = uuid.uuid4()
    route_plan_id = uuid.uuid4()
    registry = _registry(trip_id)
    ctx = _ctx(APPROVE_ROUTE)
    spec = registry.get("approve_trip_route")

    args = ApproveRouteIn(trip_id=trip_id, route_plan_id=route_plan_id)

    # Test Preview
    assert spec.preview is not None
    preview_res = await spec.preview(ctx, args)
    assert preview_res.target_type == "route_plan"
    assert preview_res.target_id == str(trip_id)
    assert preview_res.summary["action"] == "APPROVE_ROUTE_PLAN"

    # Test Execution
    exec_res = await spec.handler(ctx, args)
    assert exec_res.trip_id == trip_id
    assert exec_res.route_plan_id is not None
    assert exec_res.status == "APPROVED"



