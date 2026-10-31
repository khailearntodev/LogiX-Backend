"""Exercise the actual Agent route tools against an owned Gateway, without an LLM."""
from __future__ import annotations

import asyncio
import json
import os
import sys
from uuid import uuid4

from logix_agent.config import AgentSettings
from logix_agent.modules.auth import Actor
from logix_agent.modules.registry import ApprovedAction, ToolContext, ToolRegistry
from logix_agent.modules.tools.catalog.route import (
    APPROVE_ROUTE,
    OPTIMIZE_ROUTE,
    READ_ROUTE,
    ApproveRouteIn,
    register,
)
from logix_agent.modules.tools.http_client import create_service_client


async def main() -> None:
    command = json.loads(sys.stdin.read())
    actor = Actor(user_id=command["actorId"], tenant_id=command["tenantId"],
                  permissions=frozenset({OPTIMIZE_ROUTE, READ_ROUTE, APPROVE_ROUTE}),
                  access_token=os.environ["PHASE3_AGENT_ACCESS_TOKEN"])
    context = ToolContext(actor=actor, correlation_id=str(uuid4()))
    client = create_service_client(AgentSettings(transport_service_url=command["gatewayUrl"],
                                                tool_http_timeout_seconds=30, _env_file=None))
    try:
        tools = ToolRegistry()
        register(tools, client)
        plan = await tools.invoke("propose_trip_route", context,
                                  {"trip_id": command["tripId"], "expected_trip_version": command["tripVersion"]})
        comparison = await tools.invoke("get_route_plan_comparison", context,
                                        {"trip_id": command["tripId"], "route_plan_id": str(plan.id)})
        approval_args = ApproveRouteIn(trip_id=command["tripId"], route_plan_id=plan.id,
                                      expected_version=command["tripVersion"], plan_version=plan.plan_version,
                                      input_hash=plan.input_hash)
        preview = await tools.get("approve_trip_route").preview(context, approval_args)
        confirmation = ApprovedAction(approval_id=str(uuid4()), target_type=preview.target_type,
                                      target_id=preview.target_id, target_version=preview.target_version,
                                      execution_binding=preview.execution_binding)
        approved_context = ToolContext(actor=actor, correlation_id=context.correlation_id, approval=confirmation)
        approved = await tools.invoke("approve_trip_route", approved_context, approval_args.model_dump(mode="json"))
        print(json.dumps({
            "plan": plan.model_dump(mode="json", by_alias=True),
            "comparison": comparison.model_dump(mode="json", by_alias=True),
            "preview": preview.summary,
            "approved": approved.model_dump(mode="json", by_alias=True),
        }))
    finally:
        await client.aclose()


if __name__ == "__main__":
    asyncio.run(main())
