"""Tools backed by order-service (read-only queries and sensitive confirmation)."""

from __future__ import annotations

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

READ_ORDER = "order:sales-order:read"
CREATE_ORDER = "order:sales-order:create"
APPROVE_ORDER = "order:sales-order:approve"
BASE = "/api/v1/orders"


class OrderSummaryOut(View):
    id: UUID
    order_number: str
    status: str
    customer_id: UUID
    customer_code: str
    customer_name: str
    warehouse_id: UUID
    warehouse_code: str
    warehouse_name: str
    total_quantity: str
    total_weight: str
    total_volume: str
    created_at: datetime
    version: int


class OrderLineOut(View):
    id: UUID
    line_number: int
    product_id: UUID
    sku_snapshot: str
    product_name_snapshot: str
    unit_snapshot: str
    quantity: str


class OrderDetailOut(OrderSummaryOut):
    confirmed_at: datetime | None = None
    canceled_at: datetime | None = None
    lines: list[OrderLineOut] = Field(default_factory=list)


class ListOrdersIn(PageIn):
    q: str | None = Field(None, max_length=100, description="Search by order number")
    customer_id: UUID | None = Field(None, description="Filter by customer id")
    warehouse_id: UUID | None = Field(None, description="Filter by warehouse id")
    status: str | None = Field(None, description="Filter by status (e.g. DRAFT, CONFIRMED)")


class GetOrderIn(BaseModel):
    order_id: UUID = Field(description="Order id")


class CreateOrderLineIn(BaseModel):
    product_id: UUID = Field(description="Product UUID")
    quantity: str = Field(description="Quantity as string with up to 3 decimals, e.g. '5.000'")


class CreateOrderIn(BaseModel):
    customer_id: UUID = Field(description="Customer UUID")
    warehouse_id: UUID = Field(description="Warehouse UUID")
    product_id: UUID | None = Field(None, description="Product UUID (for single product order)")
    quantity: str | None = Field(None, description="Quantity as string e.g. '5.000' (for single product order)")
    lines: list[CreateOrderLineIn] | None = Field(None, description="List of items to order (for multi-product order)")
    delivery_address_id: UUID | None = Field(
        None,
        description="Delivery address UUID. If omitted, the customer's default shipping address will be used.",
    )
    currency: str = Field(default="VND", description="ISO 4217 currency code (default: VND)")


class ConfirmOrderIn(BaseModel):
    order_id: UUID = Field(description="Order id to confirm")
    expected_version: int | None = Field(
        None, description="Expected version of the order, taken from preview if omitted"
    )


class ConfirmOrderOut(OrderDetailOut):
    pass


def register(registry: ToolRegistry, client: ServiceClient) -> None:
    registry.register(
        read_tool(
            client=client,
            name="list_orders",
            description="List sales orders (search by order number, customer, warehouse, status).",
            service="order",
            path=BASE,
            input_model=ListOrdersIn,
            output_model=Page[OrderSummaryOut],
            permission=READ_ORDER,
        )
    )
    registry.register(
        read_tool(
            client=client,
            name="get_order",
            description="Get details of one sales order including lines, status, and snapshots.",
            service="order",
            path=f"{BASE}/{{order_id}}",
            input_model=GetOrderIn,
            output_model=OrderDetailOut,
            permission=READ_ORDER,
        )
    )

    async def preview_confirm(ctx: ToolContext, args: BaseModel) -> PreviewResult:
        assert isinstance(args, ConfirmOrderIn)
        raw = await client.request(
            "order",
            "GET",
            f"{BASE}/{args.order_id}/confirm-preview",
            ctx,
        )
        if not isinstance(raw, dict) or "version" not in raw:
            raise ToolError(TOOL_BAD_RESPONSE, "Dịch vụ đơn hàng trả về preview không hợp lệ.")
        version = int(raw["version"])
        return PreviewResult(
            target_type="sales_order",
            target_id=str(args.order_id),
            target_version=version,
            summary=raw,
        )

    async def handle_confirm(ctx: ToolContext, args: BaseModel) -> BaseModel:
        assert isinstance(args, ConfirmOrderIn)
        version = args.expected_version
        if version is None and ctx.approval is not None:
            version = ctx.approval.target_version
        if version is None:
            raise ToolError(
                "VERSION_REQUIRED",
                "Cần cung cấp phiên bản đơn hàng (version) để xác nhận.",
            )
        raw = await client.request(
            "order",
            "POST",
            f"{BASE}/{args.order_id}/confirm",
            ctx,
            json={"version": version},
        )
        try:
            return ConfirmOrderOut.model_validate(raw)
        except ValidationError:
            raise ToolError(
                TOOL_BAD_RESPONSE, "Dịch vụ đơn hàng trả về kết quả không hợp lệ."
            ) from None

    registry.register(
        ToolSpec(
            name="confirm_order",
            description=(
                "Confirm a sales order and reserve stock. Sensitive operation requiring user approval."
            ),
            input_model=ConfirmOrderIn,
            output_model=ConfirmOrderOut,
            handler=handle_confirm,
            preview=preview_confirm,
            required_permission=APPROVE_ORDER,
            risk_level=RiskLevel.WRITE,
            target_service="order",
        )
    )

    async def handle_create(ctx: ToolContext, args: BaseModel) -> BaseModel:
        assert isinstance(args, CreateOrderIn)
        delivery_address_id = args.delivery_address_id
        if delivery_address_id is None:
            raw_addrs = await client.request(
                "master_data",
                "GET",
                f"/api/v1/customers/{args.customer_id}/addresses",
                ctx,
            )
            addr_list = (
                raw_addrs
                if isinstance(raw_addrs, list)
                else raw_addrs.get("items", [])
                if isinstance(raw_addrs, dict)
                else []
            )
            default_addr = next((a for a in addr_list if a.get("isDefault")), None) or (
                addr_list[0] if addr_list else None
            )
            if not default_addr or "id" not in default_addr:
                raise ToolError(
                    "ADDRESS_NOT_FOUND",
                    "Khách hàng chưa có địa chỉ giao hàng trong hệ thống.",
                )
            delivery_address_id = UUID(default_addr["id"])

        lines_payload: list[dict[str, str]] = []
        if args.lines:
            lines_payload = [
                {"productId": str(line.product_id), "quantity": str(line.quantity)}
                for line in args.lines
            ]
        elif args.product_id and args.quantity:
            lines_payload = [
                {"productId": str(args.product_id), "quantity": str(args.quantity)}
            ]
        else:
            raise ToolError(
                "LINES_REQUIRED",
                "Cần cung cấp ít nhất một sản phẩm và số lượng (product_id + quantity hoặc lines).",
            )

        payload = {
            "customerId": str(args.customer_id),
            "deliveryAddressId": str(delivery_address_id),
            "warehouseId": str(args.warehouse_id),
            "currency": args.currency,
            "lines": lines_payload,
        }
        raw = await client.request(
            "order",
            "POST",
            BASE,
            ctx,
            json=payload,
        )
        try:
            return OrderDetailOut.model_validate(raw)
        except ValidationError:
            try:
                return OrderSummaryOut.model_validate(raw)
            except ValidationError:
                raise ToolError(
                    TOOL_BAD_RESPONSE, "Dịch vụ đơn hàng trả về kết quả không hợp lệ."
                ) from None

    registry.register(
        ToolSpec(
            name="create_order",
            description=(
                "Create a new sales order in DRAFT status for a customer with product items at a warehouse."
            ),
            input_model=CreateOrderIn,
            output_model=OrderDetailOut,
            handler=handle_create,
            required_permission=CREATE_ORDER,
            risk_level=RiskLevel.READ,
            target_service="order",
        )
    )

