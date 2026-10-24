"""Read-only tools backed by master-data-service (products, customers, warehouses)."""

from __future__ import annotations

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

from logix_agent.modules.registry import ToolRegistry
from logix_agent.modules.tools.catalog._base import Page, PageIn, View, read_tool
from logix_agent.modules.tools.http_client import ServiceClient

READ_WAREHOUSE = "inventory:warehouse:read"
BASE = "/api/v1"


class ProductOut(View):
    id: UUID
    sku: str
    name: str
    base_unit: str
    weight: str
    volume: str
    status: str


# Contact details (phone, email, tax code) are deliberately not exposed to the model.
class CustomerOut(View):
    id: UUID
    code: str
    name: str
    status: str


class WarehouseOut(View):
    id: UUID
    code: str
    name: str
    address_line: str
    ward: str | None = None
    district: str | None = None
    province: str
    status: str


class ListIn(PageIn):
    q: str | None = Field(None, max_length=200, description="Free-text search")
    status: Literal["ACTIVE", "INACTIVE"] | None = Field(None, description="Filter by status")


class ProductIdIn(BaseModel):
    product_id: UUID = Field(description="Product id")


class CustomerIdIn(BaseModel):
    customer_id: UUID = Field(description="Customer id")


class WarehouseIdIn(BaseModel):
    warehouse_id: UUID = Field(description="Warehouse id")


def register(registry: ToolRegistry, client: ServiceClient) -> None:
    def add(
        name: str,
        description: str,
        path: str,
        input_model: type[BaseModel],
        output_model: type[BaseModel],
        permission: str | None = None,
    ) -> None:
        registry.register(
            read_tool(
                client=client,
                name=name,
                description=description,
                service="master_data",
                path=path,
                input_model=input_model,
                output_model=output_model,
                permission=permission,
            )
        )

    add(
        "list_products",
        "Search products by SKU or name.",
        f"{BASE}/products",
        ListIn,
        Page[ProductOut],
    )
    add(
        "get_product",
        "Get one product by id (unit, weight, volume).",
        f"{BASE}/products/{{product_id}}",
        ProductIdIn,
        ProductOut,
    )
    add(
        "list_customers",
        "Search customers by code or name.",
        f"{BASE}/customers",
        ListIn,
        Page[CustomerOut],
    )
    add(
        "get_customer",
        "Get one customer by id.",
        f"{BASE}/customers/{{customer_id}}",
        CustomerIdIn,
        CustomerOut,
    )
    add(
        "list_warehouses",
        "Search warehouses by code or name.",
        f"{BASE}/warehouses",
        ListIn,
        Page[WarehouseOut],
        READ_WAREHOUSE,
    )
    add(
        "get_warehouse",
        "Get one warehouse by id (address).",
        f"{BASE}/warehouses/{{warehouse_id}}",
        WarehouseIdIn,
        WarehouseOut,
        READ_WAREHOUSE,
    )
