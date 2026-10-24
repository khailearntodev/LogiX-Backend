"""Expose registry tools to LangChain/LangGraph as structured tools."""

from __future__ import annotations

from langchain_core.tools import StructuredTool, ToolException

from logix_agent.modules.registry.errors import ToolRegistryError
from logix_agent.modules.registry.registry import ToolRegistry
from logix_agent.modules.registry.spec import ToolContext, ToolSpec


def to_langchain_tool(
    spec: ToolSpec, registry: ToolRegistry, context: ToolContext
) -> StructuredTool:
    async def _run(**kwargs: object) -> dict[str, object]:
        try:
            result = await registry.invoke(spec.name, context, kwargs)
        except ToolRegistryError as exc:
            # Only known failures: a broad except here would also swallow GraphInterrupt.
            raise ToolException(str(exc)) from exc
        return result.model_dump(mode="json")

    return StructuredTool.from_function(
        coroutine=_run,
        name=spec.name,
        description=spec.description,
        args_schema=spec.input_model,
        handle_tool_error=True,
    )


def tools_for_actor(registry: ToolRegistry, context: ToolContext) -> list[StructuredTool]:
    return [to_langchain_tool(spec, registry, context) for spec in registry.list_for(context.actor)]
