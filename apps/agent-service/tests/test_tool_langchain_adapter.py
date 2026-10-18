"""Unit tests for the ToolRegistry to LangChain StructuredTool adapter."""

from __future__ import annotations

from pydantic import BaseModel, Field

from logix_agent.modules.auth import Actor
from logix_agent.modules.registry import RiskLevel, ToolContext, ToolRegistry, ToolSpec
from logix_agent.modules.tools.langchain_adapter import (
    spec_to_langchain_tool,
    tools_for_actor,
)


class DummyInput(BaseModel):
    query: str = Field(description="search query")
    limit: int = Field(default=10, description="max items")


class DummyOutput(BaseModel):
    items: list[str]


def _build_test_registry() -> ToolRegistry:
    registry = ToolRegistry()

    async def h_read(ctx: ToolContext, inp: DummyInput) -> DummyOutput:
        return DummyOutput(items=[f"result for {inp.query} (user: {ctx.actor.user_id})"])

    async def h_write(ctx: ToolContext, inp: DummyInput) -> DummyOutput:
        return DummyOutput(items=[f"wrote {inp.query}"])

    registry.register(
        ToolSpec(
            name="read_data",
            description="Read data from service",
            input_model=DummyInput,
            output_model=DummyOutput,
            handler=h_read,
            required_permission="data:read",
            risk_level=RiskLevel.READ,
        )
    )
    registry.register(
        ToolSpec(
            name="write_data",
            description="Write data to service",
            input_model=DummyInput,
            output_model=DummyOutput,
            handler=h_write,
            required_permission="data:write",
            risk_level=RiskLevel.WRITE,
        )
    )
    return registry


def test_spec_to_langchain_tool_preserves_metadata_and_schema():
    registry = _build_test_registry()
    spec = registry.get("read_data")
    tool = spec_to_langchain_tool(spec, registry)

    assert tool.name == "read_data"
    assert tool.description == "Read data from service"
    assert "query" in tool.args
    assert "limit" in tool.args
    assert tool.args["query"]["type"] == "string"
    assert tool.args["limit"]["default"] == 10


def test_tools_for_actor_filters_by_permissions():
    registry = _build_test_registry()

    actor_read = Actor(
        user_id="u1",
        tenant_id="t1",
        role="MEMBER",
        permissions=frozenset({"data:read"}),
        access_token="tok",
    )
    actor_all = Actor(
        user_id="u2",
        tenant_id="t1",
        role="MEMBER",
        permissions=frozenset({"data:read", "data:write"}),
        access_token="tok",
    )
    actor_none = Actor(
        user_id="u3",
        tenant_id="t1",
        role="MEMBER",
        permissions=frozenset(),
        access_token="tok",
    )

    tools_read = tools_for_actor(registry, actor_read)
    assert [t.name for t in tools_read] == ["read_data"]

    tools_all = tools_for_actor(registry, actor_all)
    assert {t.name for t in tools_all} == {"read_data", "write_data"}

    tools_none = tools_for_actor(registry, actor_none)
    assert tools_none == []


async def test_tool_invocation_via_langchain_runner():
    registry = _build_test_registry()
    spec = registry.get("read_data")
    tool = spec_to_langchain_tool(spec, registry)

    actor = Actor(
        user_id="u123",
        tenant_id="t1",
        role="MEMBER",
        permissions=frozenset({"data:read"}),
        access_token="token-abc",
    )
    config = {
        "configurable": {
            "actor": actor,
            "correlation_id": "corr-456",
        }
    }
    result = await tool.ainvoke({"query": "warehouse-stock", "limit": 5}, config=config)
    assert result == {"items": ["result for warehouse-stock (user: u123)"]}
