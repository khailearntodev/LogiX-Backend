"""Planner agent compiled StateGraph assembly."""

from __future__ import annotations

from langchain.chat_models import init_chat_model
from langchain_core.language_models import BaseChatModel
from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.graph import END, START, StateGraph
from langgraph.graph.state import CompiledStateGraph

from logix_agent.config import settings
from logix_agent.modules.confirmations.service import (
    ConfirmationService,
    InMemoryConfirmationStore,
)
from logix_agent.modules.planner.nodes import (
    create_agent_node,
    create_confirm_node,
    create_execute_tool_node,
    create_preview_node,
    create_revalidate_and_execute_node,
    create_route_after_agent,
    create_route_after_preview,
    create_route_after_tool,
)
from logix_agent.modules.planner.state import PlannerState
from logix_agent.modules.registry.registry import ToolRegistry


def build_planner_graph(
    registry: ToolRegistry,
    checkpointer: BaseCheckpointSaver,
    *,
    model: BaseChatModel | None = None,
    confirmation_service: ConfirmationService | None = None,
    max_steps: int = 10,
) -> CompiledStateGraph:
    """Build and compile the multi-node planner graph with confirmation gate."""
    if model is None:
        model = init_chat_model(settings.agent_model, api_key=settings.gemini_api_key)

    if confirmation_service is None:
        confirmation_service = ConfirmationService(InMemoryConfirmationStore())

    agent_node = create_agent_node(model, registry)
    preview_node = create_preview_node(registry, confirmation_service)
    confirm_node = create_confirm_node()
    revalidate_and_execute_node = create_revalidate_and_execute_node(registry, confirmation_service)
    execute_tool_node = create_execute_tool_node(registry)

    route_after_agent = create_route_after_agent(registry)
    route_after_preview = create_route_after_preview()
    route_after_tool = create_route_after_tool(max_steps=max_steps)

    builder = StateGraph(PlannerState)
    builder.add_node("agent", agent_node)
    builder.add_node("preview", preview_node)
    builder.add_node("confirm", confirm_node)
    builder.add_node("revalidate_and_execute", revalidate_and_execute_node)
    builder.add_node("execute_tool", execute_tool_node)

    builder.add_edge(START, "agent")
    builder.add_conditional_edges(
        "agent",
        route_after_agent,
        {
            "preview": "preview",
            "execute_tool": "execute_tool",
            END: END,
        },
    )
    builder.add_conditional_edges(
        "preview",
        route_after_preview,
        {
            "confirm": "confirm",
            "agent": "agent",
        },
    )
    builder.add_edge("confirm", "revalidate_and_execute")
    builder.add_conditional_edges(
        "revalidate_and_execute",
        route_after_tool,
        {
            "agent": "agent",
            END: END,
        },
    )
    builder.add_conditional_edges(
        "execute_tool",
        route_after_tool,
        {
            "agent": "agent",
            END: END,
        },
    )

    return builder.compile(checkpointer=checkpointer)
