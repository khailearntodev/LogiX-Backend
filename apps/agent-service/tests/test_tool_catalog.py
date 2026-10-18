"""Tool catalog: registration, request mapping and output filtering."""

from __future__ import annotations

import uuid

import httpx
import pytest
from pydantic import ValidationError

from logix_agent.modules.auth import Actor
from logix_agent.modules.registry import (
    ApprovalRequiredError,
    ApprovedAction,
    RiskLevel,
    ToolContext,
    ToolError,
)
from logix_agent.modules.registry.registry import RESERVED_ARGUMENT_NAMES
from logix_agent.modules.tools.catalog import build_tool_registry
from logix_agent.modules.tools.http_client import ServiceClient

WH = str(uuid.uuid4())
PROD = str(uuid.uuid4())


def _ctx(*permissions: str) -> ToolContext:
    actor = Actor(
        user_id="u1",
        tenant_id="t1",
        permissions=frozenset(permissions),
        access_token="tok",
    )
    return ToolContext(actor=actor, correlation_id="c1")


def _registry(handler):  # type: ignore[no-untyped-def]
    client = ServiceClient(
        base_urls={
            "inventory": "http://inventory.test",
            "master_data": "http://master.test",
            "order": "http://order.test",
        },
        backoff_seconds=0,
        transport=httpx.MockTransport(handler),
    )
    return build_tool_registry(client)


def _balance(**extra: object) -> dict[str, object]:
    return {
        "id": str(uuid.uuid4()),
        "warehouseId": WH,
        "productId": PROD,
        "onHandQuantity": "10.000",
        "reservedQuantity": "2.000",
        "availableQuantity": "8.000",
        "lowStockThreshold": "5.000",
        "isLowStock": False,
        "updatedAt": "2026-10-01T00:00:00.000Z",
        **extra,
    }


def test_catalog_specs_and_names_are_valid() -> None:
    registry = _registry(lambda r: httpx.Response(200))
    specs = registry.list_for(_ctx("*").actor)

    assert len(specs) == 12
    read_tools = [s for s in specs if s.risk_level is RiskLevel.READ]
    sensitive_tools = [s for s in specs if s.is_sensitive]
    assert len(read_tools) == 11
    assert len(sensitive_tools) == 1
    assert sensitive_tools[0].name == "confirm_order"
    assert sensitive_tools[0].preview is not None

    for spec in specs:
        assert spec.name == spec.name.lower()
        assert not (RESERVED_ARGUMENT_NAMES & spec.input_model.model_fields.keys())


def test_tools_are_filtered_by_permission() -> None:
    registry = _registry(lambda r: httpx.Response(200))

    def names(*perms: str) -> set[str]:
        return {s.name for s in registry.list_for(_ctx(*perms).actor)}

    assert names() == {"list_products", "get_product", "list_customers", "get_customer"}
    assert "list_inventory_balances" in names("inventory:stock:read")
    assert "list_warehouses" not in names("inventory:stock:read")
    assert "list_warehouses" in names("inventory:warehouse:read")
    assert "list_orders" in names("order:sales-order:read")
    assert "get_order" in names("order:sales-order:read")
    assert "confirm_order" not in names("order:sales-order:read")
    assert "confirm_order" in names("order:sales-order:approve")


async def test_list_balances_maps_query_params() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            200, json={"items": [_balance()], "page": 1, "pageSize": 10, "total": 1}
        )

    registry = _registry(handler)
    result = await registry.invoke(
        "list_inventory_balances",
        _ctx("inventory:stock:read"),
        {"warehouse_id": WH, "low_stock_only": True},
    )

    url = seen[0].url
    assert url.path == "/api/v1/inventory/balances"
    assert dict(url.params) == {
        "page": "1",
        "pageSize": "10",
        "warehouseId": WH,
        "lowStockOnly": "true",
    }
    dumped = result.model_dump(mode="json")
    assert dumped["total"] == 1
    assert dumped["items"][0]["available_quantity"] == "8.000"


async def test_false_boolean_is_not_sent() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"items": [], "page": 1, "pageSize": 10, "total": 0})

    await _registry(handler).invoke(
        "list_inventory_balances", _ctx("inventory:stock:read"), {"low_stock_only": False}
    )
    assert "lowStockOnly" not in seen[0].url.params


async def test_get_balance_builds_path_from_ids() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=_balance())

    await _registry(handler).invoke(
        "get_inventory_balance",
        _ctx("inventory:stock:read"),
        {"warehouse_id": WH, "product_id": PROD},
    )
    assert seen[0].url.path == f"/api/v1/inventory/balances/{WH}/{PROD}"
    assert seen[0].url.query == b""


async def test_customer_contact_details_are_not_exposed() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "items": [
                    {
                        "id": str(uuid.uuid4()),
                        "code": "C001",
                        "name": "Acme",
                        "status": "ACTIVE",
                        "phone": "0901234567",
                        "email": "a@acme.test",
                        "taxCode": "123",
                    }
                ],
                "page": 1,
                "pageSize": 10,
                "total": 1,
            },
        )

    result = await _registry(handler).invoke(
        "list_customers", _ctx(), {"q": "acme", "status": "ACTIVE"}
    )
    item = result.model_dump(mode="json")["items"][0]
    assert set(item) == {"id", "code", "name", "status"}


async def test_downstream_error_surfaces_as_tool_error() -> None:
    registry = _registry(lambda r: httpx.Response(403, json={"message": "secret detail"}))
    with pytest.raises(ToolError) as exc:
        await registry.invoke(
            "get_inventory_balance",
            _ctx("inventory:stock:read"),
            {"warehouse_id": WH, "product_id": PROD},
        )
    assert exc.value.code == "TOOL_FORBIDDEN"
    assert "secret detail" not in str(exc.value)


async def test_unexpected_response_shape_is_a_tool_error() -> None:
    registry = _registry(lambda r: httpx.Response(200, json={"unexpected": True}))
    with pytest.raises(ToolError) as exc:
        await registry.invoke("list_products", _ctx(), {})
    assert exc.value.code == "TOOL_BAD_RESPONSE"


async def test_page_size_is_capped_for_the_model() -> None:
    registry = _registry(lambda r: httpx.Response(200))
    with pytest.raises(ValidationError):
        await registry.invoke("list_products", _ctx(), {"page_size": 100})


ORDER_ID = str(uuid.uuid4())
CUST_ID = str(uuid.uuid4())


def _order_summary(**extra: object) -> dict[str, object]:
    return {
        "id": ORDER_ID,
        "orderNumber": "SO-202610-0001",
        "status": "DRAFT",
        "customerId": CUST_ID,
        "customerCode": "CUST-1",
        "customerName": "Customer One",
        "warehouseId": WH,
        "warehouseCode": "WH-1",
        "warehouseName": "Warehouse One",
        "totalQuantity": "10.000",
        "totalWeight": "5.000",
        "totalVolume": "0.010000",
        "createdAt": "2026-10-01T00:00:00.000Z",
        "version": 1,
        **extra,
    }


async def test_list_orders_query_mapping() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            200, json={"items": [_order_summary()], "page": 1, "pageSize": 10, "total": 1}
        )

    registry = _registry(handler)
    result = await registry.invoke(
        "list_orders",
        _ctx("order:sales-order:read"),
        {"q": "SO-2026", "status": "DRAFT"},
    )
    assert seen[0].url.path == "/api/v1/orders"
    assert dict(seen[0].url.params) == {
        "page": "1",
        "pageSize": "10",
        "q": "SO-2026",
        "status": "DRAFT",
    }
    dumped = result.model_dump(mode="json")
    assert dumped["total"] == 1
    assert dumped["items"][0]["order_number"] == "SO-202610-0001"


async def test_confirm_order_preview() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            200,
            json={
                "version": 2,
                "checkedAt": "2026-10-18T10:00:00Z",
                "lines": [
                    {
                        "productId": PROD,
                        "required": "10.000",
                        "available": "10.000",
                        "sufficient": True,
                    }
                ],
            },
        )

    registry = _registry(handler)
    ctx = _ctx("order:sales-order:approve")
    preview = await registry.preview("confirm_order", ctx, {"order_id": ORDER_ID})

    assert seen[0].url.path == f"/api/v1/orders/{ORDER_ID}/confirm-preview"
    assert preview.target_type == "sales_order"
    assert preview.target_id == ORDER_ID
    assert preview.target_version == 2
    assert preview.summary["lines"][0]["sufficient"] is True


async def test_confirm_order_requires_approval() -> None:
    registry = _registry(lambda r: httpx.Response(200))
    ctx = _ctx("order:sales-order:approve")

    with pytest.raises(ApprovalRequiredError):
        await registry.invoke("confirm_order", ctx, {"order_id": ORDER_ID})


async def test_confirm_order_invoke_with_approval() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        detail = _order_summary(status="CONFIRMED", version=2, confirmedAt="2026-10-18T10:00:00Z")
        return httpx.Response(200, json=detail)

    registry = _registry(handler)
    actor = Actor(
        user_id="u1",
        tenant_id="t1",
        permissions=frozenset(["order:sales-order:approve"]),
        access_token="tok",
    )
    approval = ApprovedAction(
        approval_id="appr-1",
        target_type="sales_order",
        target_id=ORDER_ID,
        target_version=2,
    )
    ctx = ToolContext(actor=actor, correlation_id="c1", approval=approval)

    result = await registry.invoke("confirm_order", ctx, {"order_id": ORDER_ID})

    assert seen[0].method == "POST"
    assert seen[0].url.path == f"/api/v1/orders/{ORDER_ID}/confirm"
    import json

    assert json.loads(seen[0].content) == {"version": 2}
    dumped = result.model_dump(mode="json")
    assert dumped["status"] == "CONFIRMED"
    assert dumped["version"] == 2
