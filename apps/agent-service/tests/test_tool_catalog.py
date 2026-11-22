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
            "identity": "http://identity.test",
            "inventory": "http://inventory.test",
            "master_data": "http://master.test",
            "order": "http://order.test",
            "fulfillment": "http://fulfillment.test",
            "route_optimizer": "http://route-optimizer.test",
            "transport": "http://transport.test",
            "forecast": "http://forecast.test",
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

    assert len(specs) == 39
    read_tools = [s for s in specs if s.risk_level is RiskLevel.READ]
    sensitive_tools = [s for s in specs if s.is_sensitive]
    assert len(read_tools) == 34
    assert len(sensitive_tools) == 5
    assert {s.name for s in sensitive_tools} == {
        "confirm_order",
        "dispatch_shipment",
        "approve_trip_route",
        "complete_my_delivery_stop",
        "fail_my_delivery_stop",
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

    assert names() == {
        "get_my_workspace_context",
        "get_current_organization",
        "list_products",
        "get_product",
        "list_customers",
        "get_customer",
        "save_user_memory",
        "get_user_memories",
        "delete_user_memory",
    }
    assert "list_organization_members" in names("iam:member:read")
    assert "list_organization_roles" not in names("iam:member:read")
    assert "list_organization_roles" in names("iam:role:read")
    assert "list_vehicles" in names("transport:trip:read")
    assert "get_vehicle" in names("transport:trip:read")
    assert "list_drivers" not in names("transport:trip:read")
    assert "list_drivers" in names("master-data:driver:read")
    assert "get_driver" in names("master-data:driver:read")
    assert "list_my_assigned_trips" in names("transport:driver:read")
    assert "get_my_assigned_trip" in names("transport:driver:read")
    assert "complete_my_delivery_stop" not in names("transport:driver:read")
    assert "fail_my_delivery_stop" not in names("transport:driver:read")
    assert "complete_my_delivery_stop" in names("transport:driver:update")
    assert "fail_my_delivery_stop" in names("transport:driver:update")
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
    assert "list_trips" not in names("fulfillment:shipment:read")
    assert "list_trips" in names("transport:trip:read")
    assert "get_trip" in names("transport:trip:read")
    assert "propose_trip_route" in names("transport:route:optimize")
    assert "get_route_plan_comparison" in names("transport:route:read")
    assert "approve_trip_route" not in names("transport:route:optimize")
    assert "approve_trip_route" in names("transport:route:approve")
    assert "get_sku_demand_forecast" not in names("inventory:stock:read")
    assert "get_sku_demand_forecast" in names("forecast:read")
    assert "check_stockout_risk" in names("forecast:read")
    assert "trigger_demand_forecast" not in names("forecast:read")
    assert "trigger_demand_forecast" in names("forecast:run")


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
    assert "ui" in preview.summary
    assert preview.summary["ui"]["title"] == "Xác nhận đơn hàng"
    assert preview.summary["ui"]["icon"] == "package"
    assert preview.summary["ui"]["severity"] == "info"
    assert len(preview.summary["ui"]["table"]["rows"]) == 1


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
    assert "ui" in preview.summary
    assert preview.summary["ui"]["title"] == "Xuất kho vận chuyển"
    assert preview.summary["ui"]["icon"] == "truck"

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


async def test_identity_workspace_org_and_members_filter_pii() -> None:
    member_id = str(uuid.uuid4())
    member_user_id = str(uuid.uuid4())
    role_id = str(uuid.uuid4())

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/auth/me":
            return httpx.Response(
                200,
                json={
                    "id": "u1",
                    "displayName": "Nguyễn Điều Phối",
                    "email": "secret@logix.vn",
                    "activeTenant": {"id": "t1", "code": "LOGIX-HQ", "name": "LogiX HQ", "role": "ADMIN"},
                },
            )
        if request.url.path == "/api/v1/auth/me/permissions":
            return httpx.Response(
                200,
                json={
                    "isSuperAdmin": False,
                    "isOwner": False,
                    "isAdmin": True,
                    "roles": ["ADMIN"],
                    "permissions": ["iam:member:read", "iam:role:read"],
                },
            )
        if request.url.path == "/api/v1/auth/organizations/t1":
            return httpx.Response(
                200,
                json={
                    "id": "t1",
                    "code": "LOGIX-HQ",
                    "name": "LogiX HQ",
                    "status": "ACTIVE",
                    "role": "ADMIN",
                    "legalProfile": {"legalName": "Công ty LogiX", "province": "TP. HCM"},
                    "aiInstructions": {"enabled": True, "isDefault": False},
                },
            )
        if request.url.path == "/api/v1/iam/members":
            return httpx.Response(
                200,
                json=[
                    {
                        "id": member_id,
                        "userId": member_user_id,
                        "displayName": "Trần Tài Xế",
                        "email": "driver-private@logix.vn",
                        "phoneNumber": "0909123456",
                        "status": "ACTIVE",
                        "primaryRole": "MEMBER",
                        "roles": [{"id": role_id, "code": "DRIVER", "name": "Tài xế", "isSystem": False}],
                    }
                ],
            )
        return httpx.Response(404)

    registry = _registry(handler)
    ws = (await registry.invoke("get_my_workspace_context", _ctx(), {})).model_dump(mode="json")
    assert ws["tenant_code"] == "LOGIX-HQ"
    assert ws["roles"] == ["ADMIN"]
    assert "email" not in ws

    org = (await registry.invoke("get_current_organization", _ctx(), {})).model_dump(mode="json")
    assert org["name"] == "LogiX HQ"
    assert org["ai_instructions_is_default"] is False

    members = (
        await registry.invoke("list_organization_members", _ctx("iam:member:read"), {})
    ).model_dump(mode="json")
    assert members["total"] == 1
    assert members["items"][0]["display_name"] == "Trần Tài Xế"
    assert "email" not in members["items"][0]
    assert "phone_number" not in members["items"][0]


async def test_master_data_vehicles_and_drivers_filter_pii() -> None:
    veh_id = str(uuid.uuid4())
    drv_id = str(uuid.uuid4())
    drv_user_id = str(uuid.uuid4())

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/vehicles":
            return httpx.Response(
                200,
                json={
                    "items": [
                        {
                            "id": veh_id,
                            "code": "VEH-01",
                            "licensePlate": "51C-123.45",
                            "capacityWeight": "2500.000",
                            "capacityVolume": "12.000000",
                            "status": "ACTIVE",
                        }
                    ],
                    "page": 1,
                    "pageSize": 10,
                    "total": 1,
                },
            )
        if request.url.path == "/api/v1/drivers":
            return httpx.Response(
                200,
                json={
                    "items": [
                        {
                            "id": drv_id,
                            "code": "DRV-01",
                            "userId": drv_user_id,
                            "displayName": "Lê Văn Tài",
                            "licenseNumber": "B2-999888777",
                            "licenseExpiry": "2029-12-31",
                            "phone": "0909888999",
                            "status": "ACTIVE",
                        }
                    ],
                    "page": 1,
                    "pageSize": 10,
                    "total": 1,
                },
            )
        return httpx.Response(404)

    registry = _registry(handler)
    vehicles = (await registry.invoke("list_vehicles", _ctx("transport:trip:read"), {})).model_dump(
        mode="json"
    )
    assert vehicles["items"][0]["license_plate"] == "51C-123.45"

    drivers = (
        await registry.invoke("list_drivers", _ctx("master-data:driver:read"), {})
    ).model_dump(mode="json")
    assert drivers["items"][0]["display_name"] == "Lê Văn Tài"
    assert "license_number" not in drivers["items"][0]
    assert "phone" not in drivers["items"][0]


async def test_driver_delivery_stop_complete_and_fail_confirmation_gate() -> None:
    import json

    trip_id = str(uuid.uuid4())
    stop1_id = str(uuid.uuid4())
    stop2_id = str(uuid.uuid4())
    ship1_id = str(uuid.uuid4())
    ship2_id = str(uuid.uuid4())
    approval_uuid = str(uuid.uuid4())
    seen: list[httpx.Request] = []

    def trip_detail_payload(*, status: str = "IN_PROGRESS") -> dict[str, object]:
        return {
            "tripId": trip_id,
            "tripNumber": "TR-2026-009",
            "status": status,
            "warehouseId": WH,
            "version": 4,
            "nextStopId": stop1_id,
            "stops": [
                {
                    "stopId": stop1_id,
                    "shipmentId": ship1_id,
                    "shipmentNumber": "SH-101",
                    "approvedSequence": 1,
                    "status": "PENDING",
                    "version": 2,
                    "isNext": True,
                    "contact": {
                        "recipientName": "Kho Đại Lý Miền Nam",
                        "addressLine": "123 Lê Lợi",
                        "district": "Quận 1",
                        "province": "TP. HCM",
                    },
                },
                {
                    "stopId": stop2_id,
                    "shipmentId": ship2_id,
                    "shipmentNumber": "SH-102",
                    "approvedSequence": 2,
                    "status": "PENDING",
                    "version": 1,
                    "isNext": False,
                    "contact": {"recipientName": "Kho Bình Dương"},
                },
            ],
        }

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.method == "GET" and request.url.path == f"/api/v1/driver/trips/{trip_id}":
            return httpx.Response(200, json=trip_detail_payload())
        if request.method == "POST" and request.url.path.endswith("/deliver"):
            return httpx.Response(
                200,
                json={
                    "requestId": approval_uuid,
                    "tripId": trip_id,
                    "tripStopId": stop1_id,
                    "shipmentId": ship1_id,
                    "status": "DELIVERED",
                    "reason": None,
                    "attempt": 1,
                    "occurredAt": "2026-11-22T01:00:00.000Z",
                    "tripVersion": 5,
                    "stopVersion": 3,
                },
            )
        if request.method == "POST" and request.url.path.endswith("/fail"):
            return httpx.Response(
                200,
                json={
                    "requestId": approval_uuid,
                    "tripId": trip_id,
                    "tripStopId": stop1_id,
                    "shipmentId": ship1_id,
                    "status": "FAILED",
                    "reason": "Khách không có mặt tại kho",
                    "attempt": 1,
                    "occurredAt": "2026-11-22T01:05:00.000Z",
                    "tripVersion": 5,
                    "stopVersion": 3,
                },
            )
        return httpx.Response(404)

    registry = _registry(handler)
    ctx = _ctx("transport:driver:read", "transport:driver:update")

    # 1. Negative proof: selecting a non-next stop is rejected during preview
    with pytest.raises(ToolError) as err_not_next:
        await registry.preview(
            "complete_my_delivery_stop", ctx, {"trip_id": trip_id, "stop_id": stop2_id}
        )
    assert err_not_next.value.code == "DELIVERY_STOP_NOT_NEXT"

    # 2. Preview auto-selects the next PENDING stop and builds UniversalApprovalCard ui + binding
    preview = await registry.preview("complete_my_delivery_stop", ctx, {"trip_id": trip_id})
    assert preview.target_type == "driver_delivery_stop"
    assert preview.target_id == f"{trip_id}:{stop1_id}"
    assert preview.target_version == 4
    assert preview.summary["ui"]["title"] == "Xác nhận giao hàng thành công"
    assert preview.execution_binding == {
        "tripId": trip_id,
        "stopId": stop1_id,
        "expectedTripVersion": 4,
        "expectedStopVersion": 2,
    }

    # 3. Direct invoke without approval is blocked
    with pytest.raises(ApprovalRequiredError):
        await registry.invoke("complete_my_delivery_stop", ctx, {"trip_id": trip_id})

    # 4. Invoke with approval sends expectedTripVersion, expectedStopVersion, confirmed=True
    approval = ApprovedAction(
        approval_id=approval_uuid,
        target_type="driver_delivery_stop",
        target_id=f"{trip_id}:{stop1_id}",
        target_version=4,
        execution_binding=preview.execution_binding,
    )
    approved_ctx = ToolContext(actor=ctx.actor, correlation_id="c-drv", approval=approval)
    delivered = (
        await registry.invoke("complete_my_delivery_stop", approved_ctx, {"trip_id": trip_id})
    ).model_dump(mode="json")
    assert delivered["status"] == "DELIVERED"
    deliver_req = [r for r in seen if r.method == "POST" and r.url.path.endswith("/deliver")][0]
    deliver_body = json.loads(deliver_req.content)
    assert deliver_body == {
        "requestId": approval_uuid,
        "expectedTripVersion": 4,
        "expectedStopVersion": 2,
        "confirmed": True,
    }

    # 5. Fail stop preview + execute sends mandatory reason
    fail_preview = await registry.preview(
        "fail_my_delivery_stop",
        ctx,
        {"trip_id": trip_id, "reason": "Khách không có mặt tại kho"},
    )
    assert fail_preview.summary["ui"]["severity"] == "warning"
    failed = (
        await registry.invoke(
            "fail_my_delivery_stop",
            approved_ctx,
            {"trip_id": trip_id, "reason": "Khách không có mặt tại kho"},
        )
    ).model_dump(mode="json")
    assert failed["status"] == "FAILED"
    fail_req = [r for r in seen if r.method == "POST" and r.url.path.endswith("/fail")][0]
    fail_body = json.loads(fail_req.content)
    assert fail_body["reason"] == "Khách không có mặt tại kho"
    assert fail_body["confirmed"] is True
