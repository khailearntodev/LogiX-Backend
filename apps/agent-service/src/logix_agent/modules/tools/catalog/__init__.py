"""Tool catalog: one module per business service, assembled by `build_tool_registry`."""

from __future__ import annotations

from logix_agent.modules.registry import ToolRegistry
from logix_agent.modules.tools.catalog import inventory, master_data
from logix_agent.modules.tools.http_client import ServiceClient


def build_tool_registry(client: ServiceClient) -> ToolRegistry:
    registry = ToolRegistry()
    inventory.register(registry, client)
    master_data.register(registry, client)
    return registry
