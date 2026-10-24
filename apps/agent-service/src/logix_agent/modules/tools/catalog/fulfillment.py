"""Tools backed by fulfillment-service (shipments queries and sensitive dispatch)."""

from __future__ import annotations

import uuid
from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field, ValidationError

from logix_agent.modules.registry import (
    PreviewResult,
    RiskLevel,
    ToolContext,
    ToolError,
    ToolRegistry,
    ToolSpec,
)
from logix_agent.modules.tools.catalog._base import Page, PageIn, View, read_tool
from logix_agent.modules.tools.http_client import TOOL_BAD_RESPONSE, ServiceClient

READ_SHIPMENT = "fulfillment:shipment:read"
DISPATCH_SHIPMENT = "fulfillment:shipment:dispatch"
BASE = "/api/v1/shipments"


class ShipmentSummaryOut(View):
    id: UUID
    shipment_number: str
    order_id: UUID
    order_number: str
    warehouse_id: UUID
    status: str
    total_weight: str | float
    total_volume: str | float
    version: int
    created_at: datetime


class ShipmentItemOut(View):
    id: UUID
    order_line_id: UUID
    line_number: int
    product_id: UUID
    sku_snapshot: str
    product_name_snapshot: str
    unit_snapshot: str
    quantity: str | float


class ShipmentDetailOut(ShipmentSummaryOut):
    delivery_address_id: UUID | None = None
    reservation_group_id: UUID | None = None
    assigned_trip_id: UUID | None = None
    dispatch_issued_at: datetime | None = None
    ready_at: datetime | None = None
    delivered_at: datetime | None = None
    failed_at: datetime | None = None
    failure_reason: str | None = None
    items: list[ShipmentItemOut] = Field(default_factory=list)


class ListShipmentsIn(PageIn):
    order_id: UUID | None = Field(None, description="Filter by order id")
    warehouse_id: UUID | None = Field(None, description="Filter by warehouse id")
    status: str | None = Field(
        None,
        description="Filter by status (PENDING_PICK, PICKING, READY_TO_SHIP, DISPATCHED, DELIVERED, FAILED, CANCELED)",
    )


class GetShipmentIn(BaseModel):
    shipment_id: UUID = Field(description="Shipment id")


class DispatchShipmentIn(BaseModel):
    shipment_id: UUID = Field(description="Shipment id to dispatch")
    expected_version: int | None = Field(
        None, description="Expected version of the shipment, taken from preview if omitted"
    )
    order_version: int | None = Field(
        None, description="Expected version of the order, taken from preview if omitted"
    )


class DispatchShipmentOut(ShipmentSummaryOut):
    pass


def register(registry: ToolRegistry, client: ServiceClient) -> None:
    registry.register(
        read_tool(
            client=client,
            name="list_shipments",
            description="List shipments (filter by order id, warehouse id, status).",
            service="fulfillment",
            path=BASE,
            input_model=ListShipmentsIn,
            output_model=Page[ShipmentSummaryOut],
            permission=READ_SHIPMENT,
        )
    )
    registry.register(
        read_tool(
            client=client,
            name="get_shipment",
            description="Get details of one shipment including items, quantities, and status.",
            service="fulfillment",
            path=f"{BASE}/{{shipment_id}}",
            input_model=GetShipmentIn,
            output_model=ShipmentDetailOut,
            permission=READ_SHIPMENT,
        )
    )

    async def preview_dispatch(ctx: ToolContext, args: BaseModel) -> PreviewResult:
        assert isinstance(args, DispatchShipmentIn)
        raw = await client.request(
            "fulfillment",
            "GET",
            f"{BASE}/{args.shipment_id}/dispatch-preview",
            ctx,
        )
        if not isinstance(raw, dict) or "version" not in raw:
            raise ToolError(
                TOOL_BAD_RESPONSE, "Dịch vụ vận chuyển trả về preview không hợp lệ."
            )
        version = int(raw["version"])
        return PreviewResult(
            target_type="shipment",
            target_id=str(args.shipment_id),
            target_version=version,
            summary=raw,
        )

    async def handle_dispatch(ctx: ToolContext, args: BaseModel) -> BaseModel:
        assert isinstance(args, DispatchShipmentIn)
        version = args.expected_version
        if version is None and ctx.approval is not None:
            version = ctx.approval.target_version

        if version is None:
            raise ToolError(
                "VERSION_REQUIRED",
                "Cần cung cấp phiên bản vận đơn (version) để xuất chuyến.",
            )

        order_version = args.order_version or 1
        request_id = str(uuid.uuid4())
        raw = await client.request(
            "fulfillment",
            "POST",
            f"{BASE}/{args.shipment_id}/dispatch",
            ctx,
            json={
                "version": version,
                "orderVersion": order_version,
                "requestId": request_id,
                "confirmed": True,
            },
        )
        try:
            return DispatchShipmentOut.model_validate(raw)
        except ValidationError:
            raise ToolError(
                TOOL_BAD_RESPONSE, "Dịch vụ vận chuyển trả về kết quả không hợp lệ."
            ) from None

    registry.register(
        ToolSpec(
            name="dispatch_shipment",
            description="Dispatch a shipment to begin transport. SENSITIVE: requires confirmation.",
            risk_level=RiskLevel.WRITE,
            target_service="fulfillment",
            required_permission=DISPATCH_SHIPMENT,
            input_model=DispatchShipmentIn,
            output_model=DispatchShipmentOut,
            preview=preview_dispatch,
            handler=handle_dispatch,
        )
    )
