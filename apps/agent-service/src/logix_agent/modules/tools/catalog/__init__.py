"""Tool catalog: one module per business service, assembled by `build_tool_registry`."""

from __future__ import annotations

from logix_agent.modules.registry import ToolRegistry
from logix_agent.modules.tools.catalog import (
    driver,
    forecast,
    fulfillment,
    identity,
    inventory,
    master_data,
    memory,
    order,
    route,
)
from logix_agent.modules.tools.http_client import ServiceClient


def build_tool_registry(client: ServiceClient) -> ToolRegistry:
    registry = ToolRegistry()
    identity.register(registry, client)
    inventory.register(registry, client)
    master_data.register(registry, client)
    order.register(registry, client)
    fulfillment.register(registry, client)
    route.register(registry, client)
    driver.register(registry, client)
    forecast.register(registry, client)
    memory.register(registry)
    return registry
