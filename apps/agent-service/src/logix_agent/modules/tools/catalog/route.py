"""Tools backed by route-optimizer-service and transport-service."""

from __future__ import annotations

import uuid
from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field

from logix_agent.modules.registry import (
    PreviewResult,
    RiskLevel,
    ToolContext,
    ToolRegistry,
    ToolSpec,
)
from logix_agent.modules.tools.catalog._base import View
from logix_agent.modules.tools.http_client import ServiceClient

OPTIMIZE_ROUTE = "transport:route:optimize"
READ_ROUTE = "transport:route:read"
APPROVE_ROUTE = "transport:route:approve"


# ---------------------------------------------------------------------------
# Output / Input View Models
# ---------------------------------------------------------------------------


class StopDetailOut(View):
    trip_stop_id: UUID
    sequence: int = Field(description="Thứ tự giao tối ưu (1, 2, ...)")
    stop_name: str
    address: str
    lat: float
    lng: float
    demand_weight_kg: float
    demand_volume_m3: float
    distance_from_prev_km: float
    estimated_duration_minutes: int


class ProposedRouteOut(View):
    trip_id: UUID
    route_plan_id: UUID
    depot_name: str
    depot_address: str
    depot_lat: float
    depot_lng: float
    total_distance_km: float
    total_duration_minutes: int
    baseline_input_order_km: float
    baseline_nearest_neighbor_km: float
    distance_saved_km: float
    improvement_ratio_percent: float
    vehicle_capacity_weight_kg: float
    total_demand_weight_kg: float
    vehicle_capacity_volume_m3: float
    total_demand_volume_m3: float
    feasibility_status: str
    solver_method: str
    distance_provider: str
    stops: list[StopDetailOut]
    recommended_action: str


class MethodComparisonItem(View):
    method_name: str
    total_distance_km: float
    estimated_duration_minutes: int
    difference_from_optimal_km: float


class RouteComparisonOut(View):
    trip_id: UUID
    optimal_distance_km: float
    baseline_input_order_km: float
    baseline_nearest_neighbor_km: float
    improvement_vs_input_order_percent: float
    improvement_vs_nearest_neighbor_percent: float
    methods: list[MethodComparisonItem]
    analysis_summary: str


class ApproveRouteIn(BaseModel):
    trip_id: UUID = Field(
        description="Mã UUID của chuyến giao hàng (DeliveryTrip) cần phê duyệt lộ trình"
    )
    route_plan_id: UUID | None = Field(
        None,
        description="Mã UUID của phương án lộ trình (RoutePlan) đã đề xuất. Nếu để trống sẽ lấy từ phiên gần nhất.",
    )


class ApproveRouteOut(View):
    trip_id: UUID
    route_plan_id: UUID
    status: str
    approved_at: datetime
    message: str


class ProposeRouteIn(BaseModel):
    trip_id: UUID | None = Field(
        None,
        description="Mã UUID của chuyến giao hàng cần tối ưu lộ trình. Nếu để trống sẽ tự động giả lập chuyến mẫu.",
    )
    warehouse_id: UUID | None = Field(None, description="Mã kho xuất phát (Depot)")
    vehicle_id: UUID | None = Field(None, description="Mã phương tiện vận chuyển")
    notes: str | None = Field(None, description="Ghi chú thêm về điều kiện vận chuyển")


class GetRouteComparisonIn(BaseModel):
    trip_id: UUID = Field(
        description="Mã chuyến giao hàng cần đối chiếu so sánh các phương án lộ trình"
    )


# ---------------------------------------------------------------------------
# Tool Registration
# ---------------------------------------------------------------------------


def register(registry: ToolRegistry, client: ServiceClient) -> None:
    async def handle_propose_route(ctx: ToolContext, args: BaseModel) -> BaseModel:
        assert isinstance(args, ProposeRouteIn)
        raw = await client.request(
            "route_optimizer",
            "POST",
            "/api/v1/route-optimizations",
            ctx,
            json=args.model_dump(mode="json", exclude_none=True),
        )
        return ProposedRouteOut.model_validate(raw)

    registry.register(
        ToolSpec(
            name="propose_trip_route",
            description=(
                "Đề xuất phương án lộ trình giao hàng tối ưu (Route Optimization Proposal) cho chuyến xe (DeliveryTrip). "
                "Tính toán thứ tự dừng trên mạng lưới đường bộ OSRM và bộ giải Google OR-Tools, "
                "so sánh mức tiết kiệm quãng đường với tuyến ban đầu và kiểm tra tải trọng xe."
            ),
            input_model=ProposeRouteIn,
            output_model=ProposedRouteOut,
            handler=handle_propose_route,
            required_permission=OPTIMIZE_ROUTE,
            risk_level=RiskLevel.READ,
            target_service="route_optimizer",
        )
    )

    async def handle_get_route_comparison(ctx: ToolContext, args: BaseModel) -> BaseModel:
        assert isinstance(args, GetRouteComparisonIn)
        raw = await client.request(
            "route_optimizer",
            "GET",
            f"/api/v1/route-optimizations/{args.trip_id}",
            ctx,
        )
        route_out = ProposedRouteOut.model_validate(raw)
        methods = [
            MethodComparisonItem(
                method_name=route_out.solver_method,
                total_distance_km=route_out.total_distance_km,
                estimated_duration_minutes=route_out.total_duration_minutes,
                difference_from_optimal_km=0.0,
            ),
            MethodComparisonItem(
                method_name="Baseline: Nearest Neighbor Greedy",
                total_distance_km=route_out.baseline_nearest_neighbor_km,
                estimated_duration_minutes=max(1, round(route_out.total_duration_minutes * 1.1)),
                difference_from_optimal_km=max(0.0, round(route_out.baseline_nearest_neighbor_km - route_out.total_distance_km, 2)),
            ),
            MethodComparisonItem(
                method_name="Baseline: Original Input Order",
                total_distance_km=route_out.baseline_input_order_km,
                estimated_duration_minutes=max(1, round(route_out.total_duration_minutes * 1.25)),
                difference_from_optimal_km=max(0.0, round(route_out.baseline_input_order_km - route_out.total_distance_km, 2)),
            ),
        ]
        improvement_nn = (
            max(0.0, round(((route_out.baseline_nearest_neighbor_km - route_out.total_distance_km) / route_out.baseline_nearest_neighbor_km) * 100, 2))
            if route_out.baseline_nearest_neighbor_km > 0
            else 0.0
        )
        return RouteComparisonOut(
            trip_id=args.trip_id,
            optimal_distance_km=route_out.total_distance_km,
            baseline_input_order_km=route_out.baseline_input_order_km,
            baseline_nearest_neighbor_km=route_out.baseline_nearest_neighbor_km,
            improvement_vs_input_order_percent=route_out.improvement_ratio_percent,
            improvement_vs_nearest_neighbor_percent=improvement_nn,
            methods=methods,
            analysis_summary=route_out.recommended_action,
        )

    registry.register(
        ToolSpec(
            name="get_route_plan_comparison",
            description=(
                "Lấy báo cáo đối chiếu định lượng giữa phương án lộ trình tối ưu và các phương pháp đối chứng (Baseline). "
                "Hiển thị chi tiết quãng đường, thời gian dự kiến và tỷ lệ cải thiện."
            ),
            input_model=GetRouteComparisonIn,
            output_model=RouteComparisonOut,
            handler=handle_get_route_comparison,
            required_permission=READ_ROUTE,
            risk_level=RiskLevel.READ,
            target_service="route_optimizer",
        )
    )

    async def preview_approve_route(ctx: ToolContext, args: BaseModel) -> PreviewResult:
        assert isinstance(args, ApproveRouteIn)
        summary = {
            "tripId": str(args.trip_id),
            "routePlanId": str(args.route_plan_id or uuid.uuid4()),
            "action": "APPROVE_ROUTE_PLAN",
            "note": "Sau khi phê duyệt, chuyến giao hàng sẽ chuyển sang trạng thái APPROVED và sẵn sàng để dispatch.",
        }
        return PreviewResult(
            target_type="route_plan",
            target_id=str(args.trip_id),
            target_version=1,
            summary=summary,
        )

    async def handle_approve_route(ctx: ToolContext, args: BaseModel) -> BaseModel:
        assert isinstance(args, ApproveRouteIn)
        raw = await client.request(
            "transport",
            "POST",
            f"/api/v1/trips/{args.trip_id}/approve-route",
            ctx,
            json={"routePlanId": str(args.route_plan_id) if args.route_plan_id else None},
        )
        return ApproveRouteOut.model_validate(raw)

    registry.register(
        ToolSpec(
            name="approve_trip_route",
            description=(
                "Phê duyệt phương án lộ trình tối ưu cho chuyến xe (DeliveryTrip). "
                "Đây là hành động nhạy cảm (Risk Level: WRITE) yêu cầu người dùng xác nhận thông qua bản xem trước (Preview)."
            ),
            input_model=ApproveRouteIn,
            output_model=ApproveRouteOut,
            handler=handle_approve_route,
            preview=preview_approve_route,
            required_permission=APPROVE_ROUTE,
            risk_level=RiskLevel.WRITE,
            target_service="transport",
        )
    )

