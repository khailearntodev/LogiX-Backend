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
from logix_agent.modules.tools.catalog._base import View
from logix_agent.modules.tools.http_client import ServiceClient

OPTIMIZE_ROUTE = "transport:route:optimize"
READ_ROUTE = "transport:route:read"
APPROVE_ROUTE = "transport:route:approve"


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
    expected_trip_version: int = Field(gt=0, le=9_007_199_254_740_991)
    request_id: UUID = Field(default_factory=uuid.uuid4)


class GetRouteComparisonIn(BaseModel):
    trip_id: UUID
    route_plan_id: UUID


class ApproveRouteIn(BaseModel):
    trip_id: UUID
    route_plan_id: UUID
    expected_version: int = Field(gt=0, le=9_007_199_254_740_991)
    plan_version: int = Field(gt=0, le=9_007_199_254_740_991)
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
        return PreviewResult(
            target_type="delivery_trip", target_id=str(args.trip_id), target_version=args.expected_version,
            summary={key: value for key, value in raw.items() if key != "previewToken"},
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
