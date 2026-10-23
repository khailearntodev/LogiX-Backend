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
            "fulfillment": "http://fulfillment.test",
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

    assert len(specs) == 19
    read_tools = [s for s in specs if s.risk_level is RiskLevel.READ]
    sensitive_tools = [s for s in specs if s.is_sensitive]
    assert len(read_tools) == 16
    assert len(sensitive_tools) == 3
    assert {s.name for s in sensitive_tools} == {
        "confirm_order",
        "dispatch_shipment",
        "approve_trip_route",
    }
    for s in sensitive_tools:
        assert s.preview is not None

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
    assert "create_order" not in names("order:sales-order:read")
    assert "create_order" in names("order:sales-order:create")
    assert "confirm_order" not in names("order:sales-order:read")
    assert "confirm_order" in names("order:sales-order:approve")
    assert "list_shipments" in names("fulfillment:shipment:read")
    assert "get_shipment" in names("fulfillment:shipment:read")
    assert "dispatch_shipment" not in names("fulfillment:shipment:read")
    assert "dispatch_shipment" in names("fulfillment:shipment:dispatch")
    assert "propose_trip_route" not in names("fulfillment:shipment:read")
    assert "propose_trip_route" in names("transport:route:optimize")
    assert "get_route_plan_comparison" in names("transport:route:read")
    assert "approve_trip_route" not in names("transport:route:optimize")
    assert "approve_trip_route" in names("transport:route:approve")


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


SHIPMENT_ID = str(uuid.uuid4())


def _shipment_summary(**extra: object) -> dict[str, object]:
    return {
        "id": SHIPMENT_ID,
        "shipmentNumber": "SH-001",
        "orderId": ORDER_ID,
        "orderNumber": "SO-001",
        "warehouseId": WH,
        "status": "READY_TO_SHIP",
        "totalWeight": "15.500",
        "totalVolume": "0.035",
        "version": 1,
        "createdAt": "2026-10-18T09:00:00Z",
        **extra,
    }


async def test_list_and_get_shipments() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path == "/api/v1/shipments":
            return httpx.Response(
                200,
                json={"items": [_shipment_summary()], "page": 1, "pageSize": 10, "total": 1},
            )
        return httpx.Response(200, json=_shipment_summary(items=[]))

    registry = _registry(handler)
    ctx = _ctx("fulfillment:shipment:read")

    list_res = await registry.invoke("list_shipments", ctx, {"status": "READY_TO_SHIP"})
    assert seen[0].url.path == "/api/v1/shipments"
    assert seen[0].url.params["status"] == "READY_TO_SHIP"
    assert list_res.model_dump(mode="json")["total"] == 1

    detail_res = await registry.invoke("get_shipment", ctx, {"shipment_id": SHIPMENT_ID})
    assert seen[1].url.path == f"/api/v1/shipments/{SHIPMENT_ID}"
    assert detail_res.model_dump(mode="json")["shipment_number"] == "SH-001"


async def test_dispatch_shipment_preview_and_execute() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.method == "GET":
            return httpx.Response(
                200,
                json={
                    "shipmentId": SHIPMENT_ID,
                    "shipmentNumber": "SH-001",
                    "orderId": ORDER_ID,
                    "version": 1,
                    "orderVersion": 2,
                    "reservationGroupId": str(uuid.uuid4()),
                },
            )
        return httpx.Response(200, json=_shipment_summary(status="DISPATCHED", version=2))

    registry = _registry(handler)
    ctx = _ctx("fulfillment:shipment:dispatch")

    # 1. Preview
    preview = await registry.preview("dispatch_shipment", ctx, {"shipment_id": SHIPMENT_ID})
    assert seen[0].url.path == f"/api/v1/shipments/{SHIPMENT_ID}/dispatch-preview"
    assert preview.target_type == "shipment"
    assert preview.target_version == 1

    # 2. Invoke without approval fails
    with pytest.raises(ApprovalRequiredError):
        await registry.invoke("dispatch_shipment", ctx, {"shipment_id": SHIPMENT_ID})

    # 3. Invoke with approval succeeds
    approval = ApprovedAction(
        approval_id="appr-2",
        target_type="shipment",
        target_id=SHIPMENT_ID,
        target_version=1,
    )
    approved_ctx = ToolContext(actor=ctx.actor, correlation_id="c2", approval=approval)
    result = await registry.invoke(
        "dispatch_shipment", approved_ctx, {"shipment_id": SHIPMENT_ID, "order_version": 2}
    )

    assert seen[1].method == "POST"
    assert seen[1].url.path == f"/api/v1/shipments/{SHIPMENT_ID}/dispatch"
    import json

    body = json.loads(seen[1].content)
    assert body["version"] == 1
    assert body["orderVersion"] == 2
    assert body["confirmed"] is True
    assert result.model_dump(mode="json")["status"] == "DISPATCHED"
