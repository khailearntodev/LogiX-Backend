"""State definition for the planner agent StateGraph."""

from __future__ import annotations

from typing import Any

from langgraph.graph import MessagesState


class PlannerState(MessagesState):
    """LangGraph state for the planner agent.

    Security rule: Token and identity are NEVER stored in this state or checkpoints.
    They are injected per-turn via RunnableConfig.configurable.
    """

    step_count: int = 0
    pending_approval: dict[str, Any] | None = None
    pending_decision: Any = None
