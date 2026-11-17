"""Tests for cross-thread long-term memory backed by LangGraph BaseStore."""

from __future__ import annotations

import uuid

import httpx
import pytest
from google.genai import types as genai_types
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolCall
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.store.memory import InMemoryStore
from pydantic import Field, ValidationError

from logix_agent.config import AgentSettings
from logix_agent.modules.ai.adapters.gemini_gateway import _clean_schema_for_gemini
from logix_agent.modules.auth import Actor
from logix_agent.modules.planner.graph import build_planner_graph
from logix_agent.modules.planner.memory import (
    MAX_MEMORY_CONTENT_LENGTH,
    PROFILE_KEY,
    user_profile_namespace,
)
from logix_agent.modules.planner.store import open_store
from logix_agent.modules.registry import ToolContext, ToolError, ToolRegistry
from logix_agent.modules.tools.catalog import build_tool_registry
from logix_agent.modules.tools.catalog.memory import register as register_memory_tools
from logix_agent.modules.tools.http_client import ServiceClient


class _RecordingToolModel(GenericFakeChatModel):
    recorded_inputs: list[list[object]] = Field(default_factory=list)

    def __init__(self, responses: list[AIMessage]) -> None:
        super().__init__(messages=iter(responses))

    def bind_tools(self, tools, **kwargs):  # type: ignore[no-untyped-def]
        return self

    async def ainvoke(self, messages, config=None, **kwargs):  # type: ignore[no-untyped-def]
        self.recorded_inputs.append(list(messages))
        return await super().ainvoke(messages, config=config, **kwargs)


def _ctx(tenant_id: str, user_id: str, store: InMemoryStore | None) -> ToolContext:
    actor = Actor(user_id=user_id, tenant_id=tenant_id, role="MANAGER", access_token="tok")
    return ToolContext(actor=actor, correlation_id="corr-1", store=store)


async def test_memory_tools_crud_and_validation() -> None:
    registry = ToolRegistry()
    register_memory_tools(registry)
    store = InMemoryStore()
    ctx = _ctx("tenant-1", "user-1", store)

    saved = await registry.invoke(
        "save_user_memory",
        ctx,
        {
            "key": "Default Warehouse!",
            "content": "  Ưu tiên xuất từ kho Bình Dương WH-BD-01  ",
            "category": "rule",
        },
    )
    saved_dict = saved.model_dump()
    assert saved_dict == {
        "key": "default_warehouse",
        "content": "Ưu tiên xuất từ kho Bình Dương WH-BD-01",
        "category": "rule",
        "saved": True,
    }

    listed = await registry.invoke("get_user_memories", ctx, {})
    listed_dict = listed.model_dump()
    assert listed_dict["total"] == 1
    assert listed_dict["items"][0]["key"] == "default_warehouse"

    deleted = await registry.invoke("delete_user_memory", ctx, {"key": "Default Warehouse!"})
    assert deleted.model_dump() == {"key": "default_warehouse", "deleted": True}

    deleted_missing = await registry.invoke(
        "delete_user_memory", ctx, {"key": "default_warehouse"}
    )
    assert deleted_missing.model_dump() == {"key": "default_warehouse", "deleted": False}

    with pytest.raises(ToolError) as missing_store_exc:
        await registry.invoke(
            "save_user_memory",
            _ctx("tenant-1", "user-1", None),
            {"key": "pref", "content": "Hello"},
        )
    assert missing_store_exc.value.code == "MEMORY_UNAVAILABLE"

    with pytest.raises(ToolError) as bad_key_exc:
        await registry.invoke(
            "save_user_memory", ctx, {"key": "!!!", "content": "Valid content"}
        )
    assert bad_key_exc.value.code == "TOOL_INVALID_REQUEST"

    with pytest.raises(ValidationError):
        await registry.invoke(
            "save_user_memory",
            ctx,
            {"key": "long", "content": "x" * (MAX_MEMORY_CONTENT_LENGTH + 1)},
        )


async def test_cross_thread_memory_recall_and_no_hitl_interrupt() -> None:
    registry = ToolRegistry()
    register_memory_tools(registry)
    store = InMemoryStore()
    checkpointer = InMemorySaver()

    model = _RecordingToolModel(
        [
            AIMessage(
                content="",
                tool_calls=[
                    ToolCall(
                        name="save_user_memory",
                        args={
                            "key": "default_warehouse",
                            "content": "Tôi phụ trách kho Bình Dương WH-BD-01",
                            "category": "fact",
                        },
                        id="call_mem_1",
                    )
                ],
            ),
            AIMessage(content="Tôi đã ghi nhớ bạn phụ trách kho Bình Dương WH-BD-01."),
            AIMessage(content="Bạn phụ trách kho Bình Dương WH-BD-01."),
        ]
    )
    graph = build_planner_graph(registry, checkpointer, model=model, store=store)

    # Thread 1 saves the memory without HITL interrupt
    t1_cfg = {
        "configurable": {
            "thread_id": f"thread-mem-1-{uuid.uuid4().hex[:6]}",
            "tenant_id": "tenant-1",
            "user_id": "user-1",
            "role": "MEMBER",
            "correlation_id": "corr-1",
        }
    }
    res1 = await graph.ainvoke(
        {"messages": [HumanMessage(content="Ghi nhớ giúp tôi là tôi phụ trách kho WH-BD-01")]},
        config=t1_cfg,
    )
    assert "__interrupt__" not in res1
    assert res1["messages"][-1].content == "Tôi đã ghi nhớ bạn phụ trách kho Bình Dương WH-BD-01."

    # Thread 2 starts with an empty checkpoint for the same tenant & user
    t2_cfg = {
        "configurable": {
            "thread_id": f"thread-mem-2-{uuid.uuid4().hex[:6]}",
            "tenant_id": "tenant-1",
            "user_id": "user-1",
            "role": "MEMBER",
            "correlation_id": "corr-2",
        }
    }
    res2 = await graph.ainvoke(
        {"messages": [HumanMessage(content="Tôi phụ trách kho nào?")]},
        config=t2_cfg,
    )
    assert res2["messages"][-1].content == "Bạn phụ trách kho Bình Dương WH-BD-01."

    thread2_model_messages = model.recorded_inputs[-1]
    assert isinstance(thread2_model_messages[0], SystemMessage)
    assert "[USER LONG-TERM MEMORY]" in thread2_model_messages[0].content
    assert "Tôi phụ trách kho Bình Dương WH-BD-01" in thread2_model_messages[0].content

    # System prompt + injected memory must NOT be persisted into Thread 2 state
    t2_state = await graph.aget_state(t2_cfg)
    assert len(t2_state.values["messages"]) == 2
    assert not any(isinstance(m, SystemMessage) for m in t2_state.values["messages"])


async def test_multi_tenant_and_multi_user_isolation() -> None:
    registry = ToolRegistry()
    register_memory_tools(registry)
    store = InMemoryStore()
    await registry.invoke(
        "save_user_memory",
        _ctx("tenant-1", "user-1", store),
        {"key": "secret_rule", "content": "Luôn ưu tiên khách VIP-T1"},
    )

    # Other tenant and other user inside same tenant must see zero memories
    other_tenant = await registry.invoke(
        "get_user_memories", _ctx("tenant-2", "user-1", store), {}
    )
    other_user = await registry.invoke(
        "get_user_memories", _ctx("tenant-1", "user-2", store), {}
    )
    assert other_tenant.model_dump()["total"] == 0
    assert other_user.model_dump()["total"] == 0

    model = _RecordingToolModel(
        [
            AIMessage(content="ok other tenant"),
            AIMessage(content="ok other user"),
        ]
    )
    graph = build_planner_graph(registry, InMemorySaver(), model=model, store=store)

    await graph.ainvoke(
        {"messages": [HumanMessage(content="Hello")]},
        config={
            "configurable": {
                "thread_id": f"t-other-tenant-{uuid.uuid4().hex[:6]}",
                "tenant_id": "tenant-2",
                "user_id": "user-1",
                "role": "MEMBER",
            }
        },
    )
    await graph.ainvoke(
        {"messages": [HumanMessage(content="Hello")]},
        config={
            "configurable": {
                "thread_id": f"t-other-user-{uuid.uuid4().hex[:6]}",
                "tenant_id": "tenant-1",
                "user_id": "user-2",
                "role": "MEMBER",
            }
        },
    )

    for call_msgs in model.recorded_inputs:
        assert "VIP-T1" not in str(call_msgs[0].content)


async def test_profile_lazy_sync_filters_pii_and_caches() -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        assert request.url.path == "/api/v1/auth/me"
        return httpx.Response(
            200,
            json={
                "id": "u1",
                "displayName": "Nguyễn Quốc Huy",
                "email": "private-email@example.com",
                "phoneNumber": "0909888777",
                "activeTenant": {
                    "id": "t1",
                    "code": "LOGIX-VN",
                    "name": "LogiX Vietnam",
                    "role": "OWNER",
                },
            },
        )

    service_client = ServiceClient(
        base_urls={"identity": "http://identity.test"},
        backoff_seconds=0,
        transport=httpx.MockTransport(handler),
    )
    store = InMemoryStore()
    model = _RecordingToolModel([AIMessage(content="Chào Huy"), AIMessage(content="Chào lại Huy")])
    graph = build_planner_graph(
        ToolRegistry(), InMemorySaver(), model=model, store=store, service_client=service_client
    )

    base_cfg = {
        "tenant_id": "t1",
        "user_id": "u1",
        "access_token": "jwt-token",
        "correlation_id": "corr-1",
    }
    await graph.ainvoke(
        {"messages": [HumanMessage(content="Hi")]},
        config={"configurable": {**base_cfg, "thread_id": f"p-1-{uuid.uuid4().hex[:6]}"}},
    )
    await graph.ainvoke(
        {"messages": [HumanMessage(content="Hi again")]},
        config={"configurable": {**base_cfg, "thread_id": f"p-2-{uuid.uuid4().hex[:6]}"}},
    )
    await service_client.aclose()

    assert calls == 1  # Second turn in new thread hit the store cache
    sys_prompt = str(model.recorded_inputs[-1][0].content)
    assert "Nguyễn Quốc Huy" in sys_prompt
    assert "LogiX Vietnam (LOGIX-VN)" in sys_prompt
    assert "Role=OWNER" in sys_prompt
    assert "private-email@example.com" not in sys_prompt
    assert "0909888777" not in sys_prompt

    cached = await store.aget(user_profile_namespace("t1", "u1"), PROFILE_KEY)
    assert cached is not None
    assert set(cached.value.keys()) == {"display_name", "role", "tenant_code", "tenant_name"}


async def test_profile_sync_failure_degrades_gracefully() -> None:
    service_client = ServiceClient(
        base_urls={"identity": "http://identity.test"},
        backoff_seconds=0,
        max_attempts=1,
        transport=httpx.MockTransport(lambda _: httpx.Response(503)),
    )
    store = InMemoryStore()
    model = _RecordingToolModel([AIMessage(content="Vẫn trả lời bình thường")])
    graph = build_planner_graph(
        ToolRegistry(), InMemorySaver(), model=model, store=store, service_client=service_client
    )

    res = await graph.ainvoke(
        {"messages": [HumanMessage(content="Xin chào")]},
        config={
            "configurable": {
                "thread_id": f"p-err-{uuid.uuid4().hex[:6]}",
                "tenant_id": "t1",
                "user_id": "u1",
                "role": "MEMBER",
                "access_token": "jwt-token",
            }
        },
    )
    await service_client.aclose()
    assert res["messages"][-1].content == "Vẫn trả lời bình thường"
    assert "Role=MEMBER" in str(model.recorded_inputs[0][0].content)


def test_memory_tool_schemas_compatible_with_gemini_function_declaration() -> None:
    client = ServiceClient(base_urls={}, backoff_seconds=0)
    registry = build_tool_registry(client)
    for name in ("save_user_memory", "get_user_memories", "delete_user_memory"):
        spec = registry.get(name)
        cleaned = _clean_schema_for_gemini(spec.input_model.model_json_schema())
        decl = genai_types.FunctionDeclaration(
            name=spec.name,
            description=spec.description,
            parameters=genai_types.Schema.model_validate(cleaned),
        )
        assert decl.name == name


async def test_open_store_dev_returns_in_memory_store() -> None:
    async with open_store(AgentSettings(environment="development", database_url=None)) as store:
        assert isinstance(store, InMemoryStore)
