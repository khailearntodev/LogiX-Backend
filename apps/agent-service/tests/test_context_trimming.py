"""Tests for context window trimming and message history safety."""

from __future__ import annotations

import uuid

from langchain_core.messages import (
    AIMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
)
from langgraph.checkpoint.memory import InMemorySaver
from pydantic import BaseModel

from logix_agent.modules.planner.graph import build_planner_graph
from logix_agent.modules.planner.trimming import (
    _repair_orphan_tool_messages,
    trim_conversation_history,
)
from logix_agent.modules.registry import ToolRegistry


def test_short_history_is_unchanged():
    messages = [
        SystemMessage(content="You are LogiX Copilot"),
        HumanMessage(content="Hello"),
        AIMessage(content="Hi there!"),
    ]
    trimmed = trim_conversation_history(messages, max_tokens=1000, max_messages=10)
    assert len(trimmed) == 3
    assert trimmed == messages


def test_trimming_preserves_system_message_when_exceeding_max_messages():
    messages = [
        SystemMessage(content="System prompt"),
    ]
    # Add 10 turns (20 messages)
    for i in range(10):
        messages.append(HumanMessage(content=f"User question {i}"))
        messages.append(AIMessage(content=f"AI answer {i}"))

    # Limit to max_messages=5
    trimmed = trim_conversation_history(messages, max_tokens=10000, max_messages=5)
    assert len(trimmed) <= 5
    assert isinstance(trimmed[0], SystemMessage)
    assert trimmed[0].content == "System prompt"
    # The last message is the most recent
    assert trimmed[-1].content == "AI answer 9"


def test_repair_orphan_tool_messages_prepends_caller():
    call_id = "call_abc_123"
    ai_caller = AIMessage(
        content="",
        tool_calls=[{"name": "check_stock", "args": {"sku": "SKU-1"}, "id": call_id}],
    )
    tool_result = ToolMessage(content="In stock: 50", tool_call_id=call_id)

    original = [
        SystemMessage(content="System"),
        HumanMessage(content="Old question"),
        AIMessage(content="Old answer"),
        HumanMessage(content="Check stock for SKU-1"),
        ai_caller,
        tool_result,
        AIMessage(content="Stock is 50"),
    ]

    # Simulate a naïve slice that severed ai_caller and kept only tool_result
    severed_slice = [
        SystemMessage(content="System"),
        tool_result,
        AIMessage(content="Stock is 50"),
    ]

    repaired = _repair_orphan_tool_messages(severed_slice, original)
    assert len(repaired) == 4
    assert isinstance(repaired[0], SystemMessage)
    assert repaired[1] == ai_caller
    assert repaired[2] == tool_result
    assert repaired[3].content == "Stock is 50"


def test_repair_orphan_tool_messages_drops_when_caller_not_found():
    tool_result = ToolMessage(content="Result", tool_call_id="call_orphan")
    original = [SystemMessage(content="System"), tool_result]

    severed_slice = [SystemMessage(content="System"), tool_result]
    repaired = _repair_orphan_tool_messages(severed_slice, original)
    # Orphan is dropped to prevent provider 400 error
    assert len(repaired) == 1
    assert isinstance(repaired[0], SystemMessage)


class StockIn(BaseModel):
    sku: str


class StockOut(BaseModel):
    qty: int


async def test_planner_graph_trims_model_input_while_retaining_checkpoint():
    """Verify that trimming limits what the model sees without deleting history from the checkpointer."""
    from langchain_core.language_models.fake_chat_models import GenericFakeChatModel

    calls_seen_by_model: list[list[str]] = []

    class InspectingFakeModel(GenericFakeChatModel):
        def bind_tools(self, tools, **kwargs):
            return self

        async def ainvoke(self, messages, config=None, **kwargs):
            calls_seen_by_model.append([f"{type(m).__name__}:{m.content}" for m in messages])
            return AIMessage(content="Response from fake model")

    registry = ToolRegistry()
    checkpointer = InMemorySaver()
    model = InspectingFakeModel(messages=iter([]))

    graph = build_planner_graph(registry, checkpointer, model=model)
    thread_cfg = {
        "configurable": {
            "thread_id": f"thread-trim-{uuid.uuid4().hex[:8]}",
            "tenant_id": "tenant-1",
            "user_id": "user-1",
            "correlation_id": "corr-1",
            # Set a very low limit to trigger trimming on turn 3
            "max_history_messages": 3,
        }
    }

    # Turn 1
    await graph.ainvoke({"messages": [HumanMessage(content="Message 1")]}, config=thread_cfg)
    # Turn 2
    await graph.ainvoke({"messages": [HumanMessage(content="Message 2")]}, config=thread_cfg)
    # Turn 3
    await graph.ainvoke({"messages": [HumanMessage(content="Message 3")]}, config=thread_cfg)

    # Checkpoint still holds all conversation messages
    state = await graph.aget_state(thread_cfg)
    # 3 human messages + 3 AI replies = 6 messages in state
    assert len(state.values["messages"]) == 6

    # But the model in Turn 3 only received trimmed messages (SystemMessage + last messages)
    last_model_input = calls_seen_by_model[-1]
    assert len(last_model_input) <= 3
    assert last_model_input[0].startswith("SystemMessage:")
