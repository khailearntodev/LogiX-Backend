"""Tool registry: registration, permission filtering, invocation, LangChain bridge."""

from __future__ import annotations

import pytest
from pydantic import BaseModel, ValidationError

from logix_agent.modules.auth import Actor
from logix_agent.modules.registry import (
    DuplicateToolError,
    InvalidToolSpecError,
    RiskLevel,
    ToolContext,
    ToolError,
    ToolPermissionError,
    ToolRegistry,
    ToolSpec,
    UnknownToolError,
    to_langchain_tool,
    tools_for_actor,
)


class StockIn(BaseModel):
    sku: str


class StockOut(BaseModel):
    sku: str
    quantity: int


async def _stock_handler(ctx: ToolContext, args: BaseModel) -> BaseModel:
    assert isinstance(args, StockIn)
    return StockOut(sku=args.sku, quantity=7)


def _spec(
    name: str = "get_stock",
    permission: str = "inventory:stock:read",
    risk: RiskLevel = RiskLevel.READ,
) -> ToolSpec:
    return ToolSpec(
        name=name,
        description="Get stock level for a SKU",
        input_model=StockIn,
        output_model=StockOut,
        handler=_stock_handler,
        required_permission=permission,
        risk_level=risk,
        target_service="inventory-service",
    )


def _actor(*permissions: str, role: str | None = None) -> Actor:
    return Actor(
        user_id="u1", tenant_id="t1", role=role, permissions=frozenset(permissions)
    )


def _ctx(actor: Actor) -> ToolContext:
    return ToolContext(actor=actor, correlation_id="c1")


def test_register_duplicate_rejected() -> None:
    registry = ToolRegistry()
    registry.register(_spec())
    with pytest.raises(DuplicateToolError):
        registry.register(_spec())


def test_get_unknown_tool() -> None:
    with pytest.raises(UnknownToolError):
        ToolRegistry().get("nope")


def test_is_sensitive_follows_risk_level() -> None:
    assert not _spec().is_sensitive
    assert _spec(risk=RiskLevel.WRITE).is_sensitive
    assert _spec(risk=RiskLevel.CRITICAL).is_sensitive


def test_list_for_filters_by_permission() -> None:
    registry = ToolRegistry()
    registry.register(_spec("get_stock", "inventory:stock:read"))
    registry.register(_spec("adjust_stock", "inventory:stock:adjust", RiskLevel.WRITE))

    assert [s.name for s in registry.list_for(_actor("inventory:stock:read"))] == [
        "get_stock"
    ]
    assert registry.list_for(_actor()) == []


def test_wildcard_and_owner_see_everything() -> None:
    registry = ToolRegistry()
    registry.register(_spec("a", "x:y:z"))
    assert len(registry.list_for(_actor("*"))) == 1
    assert len(registry.list_for(_actor(role="OWNER"))) == 1


async def test_invoke_happy_path() -> None:
    registry = ToolRegistry()
    registry.register(_spec())
    result = await registry.invoke(
        "get_stock", _ctx(_actor("inventory:stock:read")), {"sku": "A1"}
    )
    assert result == StockOut(sku="A1", quantity=7)


async def test_invoke_permission_denied() -> None:
    registry = ToolRegistry()
    registry.register(_spec())
    with pytest.raises(ToolPermissionError):
        await registry.invoke("get_stock", _ctx(_actor()), {"sku": "A1"})


async def test_invoke_invalid_input() -> None:
    registry = ToolRegistry()
    registry.register(_spec())
    with pytest.raises(ValidationError):
        await registry.invoke("get_stock", _ctx(_actor("*")), {})


async def test_langchain_tool_bridge() -> None:
    registry = ToolRegistry()
    registry.register(_spec())
    ctx = _ctx(_actor("inventory:stock:read"))

    (tool,) = tools_for_actor(registry, ctx)
    assert tool.name == "get_stock"
    assert await tool.ainvoke({"sku": "A1"}) == {"sku": "A1", "quantity": 7}

    assert tools_for_actor(registry, _ctx(_actor())) == []


class ReservedIn(BaseModel):
    runtime: str


def test_reserved_argument_names_rejected() -> None:
    spec = ToolSpec(
        name="bad",
        description="d",
        input_model=ReservedIn,
        output_model=StockOut,
        handler=_stock_handler,
        required_permission="x:y:z",
    )
    with pytest.raises(InvalidToolSpecError):
        ToolRegistry().register(spec)


async def test_bridge_turns_known_errors_into_tool_output() -> None:
    async def failing(ctx: ToolContext, args: BaseModel) -> BaseModel:
        raise ToolError("TOOL_TIMEOUT", "Dịch vụ phản hồi quá lâu.")

    registry = ToolRegistry()
    registry.register(
        ToolSpec(
            name="slow",
            description="d",
            input_model=StockIn,
            output_model=StockOut,
            handler=failing,
            required_permission="x:y:z",
        )
    )
    (tool,) = tools_for_actor(registry, _ctx(_actor("*")))
    assert await tool.ainvoke({"sku": "A1"}) == "Dịch vụ phản hồi quá lâu."


async def test_bridge_does_not_swallow_unexpected_errors() -> None:
    async def broken(ctx: ToolContext, args: BaseModel) -> BaseModel:
        raise RuntimeError("bug")

    registry = ToolRegistry()
    registry.register(
        ToolSpec(
            name="broken",
            description="d",
            input_model=StockIn,
            output_model=StockOut,
            handler=broken,
            required_permission="x:y:z",
        )
    )
    (tool,) = tools_for_actor(registry, _ctx(_actor("*")))
    with pytest.raises(RuntimeError):
        await tool.ainvoke({"sku": "A1"})


async def test_bridge_returns_permission_error_as_output() -> None:
    registry = ToolRegistry()
    registry.register(_spec())
    # Bypass list_for to prove invoke still enforces permission.
    tool = to_langchain_tool(registry.get("get_stock"), registry, _ctx(_actor()))
    assert "Permission denied" in await tool.ainvoke({"sku": "A1"})
