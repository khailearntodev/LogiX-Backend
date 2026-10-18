"""Read-only tools for the create_agent flow: plain @tool functions calling business services."""

import logging
import time
from typing import Literal
from uuid import UUID

import httpx
from langchain.tools import ToolRuntime, tool

from logix_agent.config import settings

logger = logging.getLogger(__name__)

# Keeps tool results small enough for the model context.
MAX_PAGE_SIZE = 20

BALANCE_FIELDS = (
    "warehouseId",
    "productId",
    "onHandQuantity",
    "reservedQuantity",
    "availableQuantity",
    "lowStockThreshold",
    "isLowStock",
)
PRODUCT_FIELDS = ("id", "sku", "name", "baseUnit", "weight", "volume", "status")


async def _get(base_url: str, path: str, runtime: ToolRuntime, params: dict) -> dict:
    # Identity comes from the verified token (router), never from model output.
    configurable = runtime.config.get("configurable", {})
    headers = {"Authorization": f"Bearer {configurable['access_token']}"}
    if correlation_id := configurable.get("correlation_id"):
        headers["X-Correlation-Id"] = correlation_id
    params = {key: value for key, value in params.items() if value is not None}
    started = time.monotonic()
    async with httpx.AsyncClient(timeout=settings.tool_http_timeout_seconds) as client:
        response = await client.get(f"{base_url}{path}", params=params, headers=headers)
    logger.info(
        "GET %s -> %s in %.0fms",
        path,
        response.status_code,
        (time.monotonic() - started) * 1000,
    )
    response.raise_for_status()
    return response.json()


def _pick(item: dict, fields: tuple[str, ...]) -> dict:
    return {field: item.get(field) for field in fields}


def _page(raw: dict, fields: tuple[str, ...]) -> dict:
    return {
        "items": [_pick(item, fields) for item in raw["items"]],
        "page": raw["page"],
        "page_size": raw["pageSize"],
        "total": raw["total"],
    }


@tool
async def list_inventory_balances(
    runtime: ToolRuntime,
    warehouse_id: UUID | None = None,
    product_id: UUID | None = None,
    low_stock_only: bool = False,
    page: int = 1,
    page_size: int = 10,
) -> dict:
    """List stock balances per warehouse and product (on hand, reserved, available).

    Args:
        warehouse_id: Only this warehouse.
        product_id: Only this product.
        low_stock_only: Only items at or below their low-stock threshold.
        page: Page number, starting at 1.
        page_size: Rows per page, at most 20.
    """
    params = {
        "warehouseId": warehouse_id,
        "productId": product_id,
        "page": page,
        "pageSize": min(page_size, MAX_PAGE_SIZE),
        # The service reads the string "false" as true, so only send it when set.
        "lowStockOnly": True if low_stock_only else None,
    }
    raw = await _get(settings.inventory_service_url, "/api/v1/inventory/balances", runtime, params)
    return _page(raw, BALANCE_FIELDS)


@tool
async def get_inventory_balance(runtime: ToolRuntime, warehouse_id: UUID, product_id: UUID) -> dict:
    """Get the stock balance of one product in one warehouse.

    Args:
        warehouse_id: Warehouse id.
        product_id: Product id.
    """
    path = f"/api/v1/inventory/balances/{warehouse_id}/{product_id}"
    raw = await _get(settings.inventory_service_url, path, runtime, {})
    return _pick(raw, BALANCE_FIELDS)


@tool
async def list_products(
    runtime: ToolRuntime,
    q: str | None = None,
    status: Literal["ACTIVE", "INACTIVE"] | None = None,
    page: int = 1,
    page_size: int = 10,
) -> dict:
    """Search products by SKU or name.

    Args:
        q: Text to search for in SKU or name.
        status: Only products with this status.
        page: Page number, starting at 1.
        page_size: Rows per page, at most 20.
    """
    params = {
        "q": q,
        "status": status,
        "page": page,
        "pageSize": min(page_size, MAX_PAGE_SIZE),
    }
    raw = await _get(settings.master_data_service_url, "/api/v1/products", runtime, params)
    return _page(raw, PRODUCT_FIELDS)


TOOLS = [list_inventory_balances, get_inventory_balance, list_products]
