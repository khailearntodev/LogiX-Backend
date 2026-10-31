"""Contract-tier HTTP adapter tests; not a replacement for real Transport integration."""
from __future__ import annotations

import json
from uuid import uuid4

import httpx
import pytest
from pydantic import ValidationError

from logix_agent.modules.auth import Actor
from logix_agent.modules.registry import ApprovedAction, RiskLevel, ToolContext, ToolError
from logix_agent.modules.tools.catalog import build_tool_registry
from logix_agent.modules.tools.catalog.route import (
    APPROVE_ROUTE,
    OPTIMIZE_ROUTE,
    READ_ROUTE,
    ApproveRouteIn,
    GetRouteComparisonIn,
    ProposeRouteIn,
    RoutePlanOut,
    selection,
)
from logix_agent.modules.tools.http_client import ServiceClient


@pytest.fixture
def wire() -> dict:
    return {
        "id": str(uuid4()), "tripId": str(uuid4()), "planVersion": 7, "version": 1,
        "source": "OPTIMIZED", "inputHash": "a" * 64, "optimizationRunId": str(uuid4()),
        "totalDistance": "12.345", "estimatedCost": None,
        "metrics": {"baseline_input_order_km": 14.2, "total_duration_minutes": 42},
        "approvedBy": None, "approvedAt": None, "stops": [{"tripStopId": str(uuid4()), "sequence": 1, "eta": None}],
    }


def context(*permissions: str, approval: ApprovedAction | None = None) -> ToolContext:
    return ToolContext(actor=Actor(user_id=str(uuid4()), tenant_id=str(uuid4()),
                                  permissions=frozenset(permissions), access_token="owned-test-token"),
                       correlation_id=str(uuid4()), approval=approval)


def registry(handler: object):
    client = ServiceClient(base_urls={"transport": "http://transport.owned.test"},
                           backoff_seconds=0, transport=httpx.MockTransport(handler))
    return build_tool_registry(client)


def args(wire: dict) -> ApproveRouteIn:
    return ApproveRouteIn(trip_id=wire["tripId"], route_plan_id=wire["id"],
                          expected_version=3, plan_version=wire["planVersion"], input_hash=wire["inputHash"])


def test_tools_registered_permission_filtered_and_owned_by_transport(wire: dict) -> None:
    tools = registry(lambda request: httpx.Response(200, json=wire))
    assert not {s.name for s in tools.list_for(context().actor)} & {
        "propose_trip_route", "get_route_plan_comparison", "approve_trip_route"}
    specs = {s.name: s for s in tools.list_for(context(OPTIMIZE_ROUTE, READ_ROUTE, APPROVE_ROUTE).actor)}
    for name in ["propose_trip_route", "get_route_plan_comparison", "approve_trip_route"]:
        assert specs[name].target_service == "transport"
    assert specs["approve_trip_route"].risk_level is RiskLevel.WRITE
    assert specs["approve_trip_route"].preview is not None


def test_inputs_never_manufacture_trip_versions_or_plan_identity(wire: dict) -> None:
    with pytest.raises(ValidationError):
        ProposeRouteIn(trip_id=wire["tripId"])
    with pytest.raises(ValidationError):
        ApproveRouteIn(trip_id=wire["tripId"], route_plan_id=wire["id"])
    with pytest.raises(ValidationError):
        GetRouteComparisonIn(route_plan_id=wire["id"])


@pytest.mark.asyncio
async def test_optimizer_and_comparison_use_real_trip_plan_paths_and_persisted_metrics(wire: dict) -> None:
    calls: list[httpx.Request] = []
    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(201 if request.method == "POST" else 200, json=wire)
    tools = registry(handler)
    proposal = ProposeRouteIn(trip_id=wire["tripId"], expected_trip_version=3)
    result = await tools.get("propose_trip_route").handler(context(OPTIMIZE_ROUTE), proposal)
    assert isinstance(result, RoutePlanOut)
    assert str(result.id) == wire["id"]
    assert str(result.optimization_run_id) == wire["optimizationRunId"]
    assert result.optimization_run_id != result.id
    assert calls[0].url.path == f"/api/v1/trips/{wire['tripId']}/route-optimizations"
    assert json.loads(calls[0].content) == {"requestId": str(proposal.request_id), "expectedTripVersion": 3}
    result = await tools.get("get_route_plan_comparison").handler(context(READ_ROUTE),
        GetRouteComparisonIn(trip_id=wire["tripId"], route_plan_id=wire["id"]))
    assert result.metrics == wire["metrics"]
    assert result.estimated_cost is None
    assert calls[1].url.path == f"/api/v1/trips/{wire['tripId']}/route-plans/{wire['id']}"


@pytest.mark.asyncio
async def test_approval_uses_original_backend_preview_token_and_stable_confirmation_request(wire: dict) -> None:
    command = args(wire)
    calls: list[httpx.Request] = []
    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if request.url.path.endswith("route-approval-preview"):
            return httpx.Response(200, json={"tripId": wire["tripId"], **selection(command),
                                           "action": "APPROVE", "previewToken": "original-backend-signed-token"})
        return httpx.Response(200, json={"id": wire["tripId"], "status": "APPROVED", "version": 4,
                                       "approvedRoutePlanId": str(uuid4())})
    tools = registry(handler)
    tool = tools.get("approve_trip_route")
    preview = await tool.preview(context(APPROVE_ROUTE), command)
    assert "previewToken" not in preview.summary
    approval = ApprovedAction(approval_id=str(uuid4()), target_type="delivery_trip", target_id=wire["tripId"],
                              target_version=3, execution_binding=preview.execution_binding)
    result = await tool.handler(context(APPROVE_ROUTE, approval=approval), command)
    assert result.status == "APPROVED"
    sent = json.loads(calls[-1].content)
    assert sent == {**selection(command), "requestId": approval.approval_id, "confirmed": True,
                    "previewToken": "original-backend-signed-token"}
    assert len(calls) == 2
    with pytest.raises(ToolError):
        await tool.handler(context(APPROVE_ROUTE), command)
    approval.execution_binding["planVersion"] = 999
    with pytest.raises(ToolError):
        await tool.handler(context(APPROVE_ROUTE, approval=approval), command)
    assert len(calls) == 2


@pytest.mark.asyncio
async def test_preview_rejects_unbound_backend_reply(wire: dict) -> None:
    command = args(wire)
    tools = registry(lambda request: httpx.Response(200, json={
        "tripId": wire["tripId"], **selection(command), "action": "APPROVE",
        "previewToken": "token", "planVersion": 999,
    }))
    with pytest.raises(ToolError):
        await tools.get("approve_trip_route").preview(context(APPROVE_ROUTE), command)
