"""Read-only tools backed by inventory-service."""

from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

from logix_agent.modules.registry import ToolRegistry
from logix_agent.modules.tools.catalog._base import Page, PageIn, View, read_tool
from logix_agent.modules.tools.http_client import ServiceClient

READ_STOCK = "inventory:stock:read"
BASE = "/api/v1/inventory"


class BalanceOut(View):
    id: UUID
    warehouse_id: UUID
    product_id: UUID
    on_hand_quantity: str
    reserved_quantity: str
    available_quantity: str
    low_stock_threshold: str
    is_low_stock: bool
    updated_at: datetime


class MovementOut(View):
    id: UUID
    warehouse_id: UUID
    product_id: UUID
    movement_type: str
    quantity_delta: str
    before_on_hand: str
    after_on_hand: str
    reference_type: str | None = None
    reference_id: UUID | None = None
    reason: str | None = None
    occurred_at: datetime


class ListBalancesIn(PageIn):
    warehouse_id: UUID | None = Field(None, description="Filter by warehouse id")
    product_id: UUID | None = Field(None, description="Filter by product id")
    low_stock_only: bool = Field(
        False, description="Only return balances at or below their low-stock threshold"
    )


class GetBalanceIn(BaseModel):
    warehouse_id: UUID = Field(description="Warehouse id")
    product_id: UUID = Field(description="Product id")


class ListMovementsIn(PageIn):
    warehouse_id: UUID | None = Field(None, description="Filter by warehouse id")
    product_id: UUID | None = Field(None, description="Filter by product id")
    reference_type: Literal["STOCK_RECEIPT", "MANUAL_ADJUSTMENT"] | None = Field(
        None, description="Filter by what caused the movement"
    )
    reference_id: UUID | None = Field(None, description="Filter by reference document id")


def register(registry: ToolRegistry, client: ServiceClient) -> None:
    registry.register(
        read_tool(
            client=client,
            name="list_inventory_balances",
            description=(
                "List stock balances per warehouse and product (on hand, reserved, available). "
                "Use low_stock_only to find items running low."
            ),
            service="inventory",
            path=f"{BASE}/balances",
            input_model=ListBalancesIn,
            output_model=Page[BalanceOut],
            permission=READ_STOCK,
        )
    )
    registry.register(
        read_tool(
            client=client,
            name="get_inventory_balance",
            description="Get the stock balance of one product in one warehouse.",
            service="inventory",
            path=f"{BASE}/balances/{{warehouse_id}}/{{product_id}}",
            input_model=GetBalanceIn,
            output_model=BalanceOut,
            permission=READ_STOCK,
        )
    )
    registry.register(
        read_tool(
            client=client,
            name="list_stock_movements",
            description="List stock movement history (receipts, issues, adjustments), newest first.",
            service="inventory",
            path=f"{BASE}/movements",
            input_model=ListMovementsIn,
            output_model=Page[MovementOut],
            permission=READ_STOCK,
        )
    )
