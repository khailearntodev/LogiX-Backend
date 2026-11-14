"""Route intent goes through Transport; tools never manufacture plans or versions."""
from __future__ import annotations

import uuid
from typing import Any
from uuid import UUID

from pydantic import BaseModel, Field

from logix_agent.modules.registry import (
    PreviewResult,
    RiskLevel,
    ToolContext,
    ToolError,
    ToolRegistry,
    ToolSpec,
)
from logix_agent.modules.tools.catalog._base import Page, PageIn, View, read_tool
from logix_agent.modules.tools.http_client import ServiceClient

READ_TRIP = "transport:trip:read"
OPTIMIZE_ROUTE = "transport:route:optimize"
READ_ROUTE = "transport:route:read"
APPROVE_ROUTE = "transport:route:approve"
TRIPS_BASE = "/api/v1/trips"


class TripSummaryOut(View):
    id: UUID
    trip_number: str
    warehouse_id: UUID
    vehicle_id: UUID | None = None
    driver_id: UUID | None = None
    status: str
    planned_start_at: str
    total_weight: str | float
    total_volume: str | float
    version: int
    total_stops: int = 0
    completed_stops: int = 0


class TripShipmentOut(View):
    id: UUID
    shipment_id: UUID
    order_id: UUID | None = None
    warehouse_id: UUID
    state: str
    weight: str | float
    volume: str | float


class TripStopOut(View):
    id: UUID
    shipment_id: UUID
    delivery_address_id: UUID | None = None
    latitude: str | float | None = None
    longitude: str | float | None = None
    weight: str | float | None = None
    volume: str | float | None = None
    planned_sequence: int
    approved_sequence: int | None = None
    status: str


class TripDetailOut(TripSummaryOut):
    approved_route_plan_id: UUID | None = None
    actual_start_at: str | None = None
    dispatched_at: str | None = None
    completed_at: str | None = None
    canceled_at: str | None = None
    cancel_reason: str | None = None
    shipments: list[TripShipmentOut] = Field(default_factory=list)
    stops: list[TripStopOut] = Field(default_factory=list)


class ListTripsIn(PageIn):
    search: str | None = Field(
        None, description="Tìm kiếm theo mã chuyến xe (ví dụ: TRIP-DEMO-01)"
    )
    warehouse_id: UUID | None = Field(None, description="Lọc theo UUID kho xuất phát")
    status: str | None = Field(
        None,
        description="Lọc theo trạng thái chuyến xe (DRAFT, APPROVED, IN_PROGRESS, COMPLETED, CANCELED)",
    )
    vehicle_id: UUID | None = Field(None, description="Lọc theo UUID xe tải")
    driver_id: UUID | None = Field(None, description="Lọc theo UUID tài xế")


class GetTripIn(BaseModel):
    trip_id: UUID = Field(description="UUID của chuyến xe cần xem chi tiết")


class RoutePlanOut(View):
    id: UUID
    trip_id: UUID
    plan_version: int
    version: int
    source: str
    input_hash: str
    optimization_run_id: UUID | None
    total_distance: str | None
    estimated_cost: str | None
    metrics: dict[str, Any] | None
    approved_by: UUID | None
    approved_at: str | None
    stops: list[dict[str, Any]]


class ProposeRouteIn(BaseModel):
    trip_id: UUID
    expected_trip_version: int = Field(ge=1, le=9_007_199_254_740_991)
    request_id: UUID = Field(default_factory=uuid.uuid4)


class GetRouteComparisonIn(BaseModel):
    trip_id: UUID
    route_plan_id: UUID


class ApproveRouteIn(BaseModel):
    trip_id: UUID
    route_plan_id: UUID
    expected_version: int = Field(ge=1, le=9_007_199_254_740_991)
    plan_version: int = Field(ge=1, le=9_007_199_254_740_991)
    input_hash: str = Field(pattern=r"^[a-f0-9]{64}$")


class ApproveRouteOut(View):
    id: UUID
    status: str
    version: int
    approved_route_plan_id: UUID


def selection(args: ApproveRouteIn) -> dict[str, object]:
    return {"expectedVersion": args.expected_version, "planId": str(args.route_plan_id),
            "planVersion": args.plan_version, "inputHash": args.input_hash}


def register(registry: ToolRegistry, client: ServiceClient) -> None:
    registry.register(
        read_tool(
            client=client,
            name="list_trips",
            description="Danh sách các chuyến xe vận chuyển (lọc theo mã chuyến search, kho warehouse_id, trạng thái status, xe vehicle_id, tài xế driver_id) để lấy trip_id và version hiện tại.",
            service="transport",
            path=TRIPS_BASE,
            input_model=ListTripsIn,
            output_model=Page[TripSummaryOut],
            permission=READ_TRIP,
        )
    )
    registry.register(
        read_tool(
            client=client,
            name="get_trip",
            description="Xem chi tiết một chuyến xe vận chuyển bao gồm version hiện tại, danh sách vận đơn (shipments) và các điểm dừng giao hàng (stops).",
            service="transport",
            path=f"{TRIPS_BASE}/{{trip_id}}",
            input_model=GetTripIn,
            output_model=TripDetailOut,
            permission=READ_TRIP,
        )
    )

    async def propose(ctx: ToolContext, args: BaseModel) -> BaseModel:
        assert isinstance(args, ProposeRouteIn)
        raw = await client.request("transport", "POST", f"/api/v1/trips/{args.trip_id}/route-optimizations", ctx,
                                   json={"requestId": str(args.request_id), "expectedTripVersion": args.expected_trip_version})
        return RoutePlanOut.model_validate(raw)

    registry.register(ToolSpec(
        name="propose_trip_route", description="Đề xuất tuyến cho chuyến DRAFT thật qua Transport; không duyệt hoặc dispatch.",
        input_model=ProposeRouteIn, output_model=RoutePlanOut, handler=propose,
        required_permission=OPTIMIZE_ROUTE, risk_level=RiskLevel.READ, target_service="transport",
    ))

    async def comparison(ctx: ToolContext, args: BaseModel) -> BaseModel:
        assert isinstance(args, GetRouteComparisonIn)
        raw = await client.request("transport", "GET", f"/api/v1/trips/{args.trip_id}/route-plans/{args.route_plan_id}", ctx)
        # Stored provider metrics include the distinct optimization run ID and real baselines.
        return RoutePlanOut.model_validate(raw)

    registry.register(ToolSpec(
        name="get_route_plan_comparison", description="Đọc phiên bản tuyến và metrics/baseline thực đã lưu; dữ liệu chưa đo là null.",
        input_model=GetRouteComparisonIn, output_model=RoutePlanOut, handler=comparison,
        required_permission=READ_ROUTE, risk_level=RiskLevel.READ, target_service="transport",
    ))

    async def preview(ctx: ToolContext, args: BaseModel) -> PreviewResult:
        assert isinstance(args, ApproveRouteIn)
        raw = await client.request("transport", "POST", f"/api/v1/trips/{args.trip_id}/route-approval-preview", ctx, json=selection(args))
        if not isinstance(raw, dict) or not isinstance(raw.get("previewToken"), str) or raw.get("tripId") != str(args.trip_id) or raw.get("action") != "APPROVE" or any(raw.get(key) != value for key, value in selection(args).items()):
            raise ToolError("TOOL_BAD_RESPONSE", "Backend không trả preview tuyến hợp lệ.")
        ui = {
            "title": "Phê duyệt lộ trình chuyến xe",
            "subtitle": f"Chuyến xe #{str(args.trip_id)[:16]}",
            "icon": "map-pin",
            "severity": "info",
            "impact": "Lộ trình tối ưu sẽ được áp dụng chính thức cho chuyến xe này.",
            "attributes": [
                {"label": "Mã chuyến xe", "value": str(args.trip_id)[:16]},
                {"label": "Kế hoạch lộ trình", "value": str(args.route_plan_id)[:16]},
                {"label": "Phiên bản chuyến xe", "value": str(args.expected_version)},
                {"label": "Phiên bản kế hoạch", "value": str(args.plan_version)},
            ],
        }
        summary = {key: value for key, value in raw.items() if key != "previewToken"}
        summary["ui"] = ui
        return PreviewResult(
            target_type="delivery_trip", target_id=str(args.trip_id), target_version=args.expected_version,
            summary=summary,
            execution_binding={"previewToken": raw["previewToken"], **selection(args)},
        )

    async def approve(ctx: ToolContext, args: BaseModel) -> BaseModel:
        assert isinstance(args, ApproveRouteIn)
        approval = ctx.approval
        if approval is None or approval.target_type != "delivery_trip" or approval.target_id != str(args.trip_id) or approval.target_version != args.expected_version:
            raise ToolError("CONFIRMATION_REQUIRED", "Phải xác nhận preview backend của đúng chuyến và phiên bản.")
        binding = approval.execution_binding
        if binding is None or not isinstance(binding.get("previewToken"), str) or any(binding.get(key) != value for key, value in selection(args).items()):
            raise ToolError("CONFIRMATION_REQUIRED", "Preview backend không khớp ý định đã xác nhận.")
        raw = await client.request("transport", "POST", f"/api/v1/trips/{args.trip_id}/approve-route", ctx,
                                   json={**selection(args), "requestId": approval.approval_id,
                                         "confirmed": True, "previewToken": binding["previewToken"]})
        return ApproveRouteOut.model_validate(raw)

    registry.register(ToolSpec(
        name="approve_trip_route", description="Duyệt chuyến DRAFT bằng preview backend và xác nhận người dùng; không dispatch.",
        input_model=ApproveRouteIn, output_model=ApproveRouteOut, handler=approve, preview=preview,
        required_permission=APPROVE_ROUTE, risk_level=RiskLevel.WRITE, target_service="transport",
    ))
