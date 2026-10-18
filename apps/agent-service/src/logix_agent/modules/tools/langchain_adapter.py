"""Bridge between LogiX ToolRegistry and LangChain/LangGraph tools."""

from __future__ import annotations

from typing import Any

from langchain_core.runnables import RunnableConfig
from langchain_core.tools import StructuredTool

from logix_agent.modules.auth import Actor
from logix_agent.modules.registry.registry import ToolRegistry
from logix_agent.modules.registry.spec import ToolContext, ToolSpec


def spec_to_langchain_tool(spec: ToolSpec, registry: ToolRegistry) -> StructuredTool:
    """Wrap a LogiX ToolSpec into a LangChain StructuredTool for model schema binding."""

    async def _invoke_via_registry(config: RunnableConfig, **kwargs: Any) -> Any:
        configurable = config.get("configurable", {})
        actor = configurable.get("actor")
        if not isinstance(actor, Actor):
            # Fall back to reconstructing Actor from configurable fields if individual strings were passed
            actor = Actor(
                user_id=str(configurable.get("user_id", "")),
                tenant_id=str(configurable.get("tenant_id", "")),
                role=str(configurable.get("role", "MEMBER")),
                permissions=frozenset(configurable.get("permissions", ())),
                access_token=str(configurable.get("access_token", "")),
            )
        context = ToolContext(
            actor=actor,
            correlation_id=str(configurable.get("correlation_id", "")),
            approval=configurable.get("approval"),
        )
        result = await registry.invoke(spec.name, context, kwargs)
        return result.model_dump()

    return StructuredTool.from_function(
        name=spec.name,
        description=spec.description,
        args_schema=spec.input_model,
        coroutine=_invoke_via_registry,
    )


def tools_for_actor(registry: ToolRegistry, actor: Actor) -> list[StructuredTool]:
    """Return LangChain-compatible tools authorized for the given actor."""
    specs = registry.list_for(actor)
    return [spec_to_langchain_tool(spec, registry) for spec in specs]
