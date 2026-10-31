"""End-to-end tests for Planner StateGraph routing, tool execution, and confirmation gate."""

from __future__ import annotations

import json
import time
import uuid
from collections.abc import Iterator

import jwt
import pytest
from httpx import ASGITransport, AsyncClient
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import (
    AIMessage,
    AIMessageChunk,
    HumanMessage,
    ToolCall,
    ToolCallChunk,
)
from langchain_core.outputs import ChatGenerationChunk
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.types import Command
from pydantic import BaseModel

from logix_agent.config import settings
from logix_agent.main import app
from logix_agent.modules.agui.router import build_agui_runtime
from logix_agent.modules.confirmations.service import (
    ConfirmationService,
    InMemoryConfirmationStore,
)
from logix_agent.modules.planner.graph import build_planner_graph
from logix_agent.modules.registry import (
    PreviewResult,
    RiskLevel,
    ToolContext,
    ToolRegistry,
    ToolSpec,
)

SECRET = "test-secret"


class FakeToolModel(GenericFakeChatModel):
    def bind_tools(self, tools, **kwargs):  # type: ignore[no-untyped-def]
        return self

    def _stream(self, messages, stop=None, run_manager=None, **kwargs):  # type: ignore[no-untyped-def]
        chat_result = self._generate(messages, stop=stop, run_manager=run_manager, **kwargs)
        message = chat_result.generations[0].message
        tool_chunks = [
            ToolCallChunk(
                name=tc["name"],
                args=json.dumps(tc.get("args", {})),
                id=tc.get("id"),
                index=i,
            )
            for i, tc in enumerate(getattr(message, "tool_calls", []))
        ]
        chunk = ChatGenerationChunk(
            message=AIMessageChunk(
                content=message.content or "",
                tool_calls=getattr(message, "tool_calls", []),
                tool_call_chunks=tool_chunks,
                id=message.id,
            )
        )
        if run_manager and message.content:
            run_manager.on_llm_new_token(message.content, chunk=chunk)
        yield chunk

    async def _astream(self, messages, stop=None, run_manager=None, **kwargs):  # type: ignore[no-untyped-def]
        for c in self._stream(messages, stop=stop, run_manager=run_manager, **kwargs):
            yield c


class ReadInput(BaseModel):
    product_sku: str


class ReadOutput(BaseModel):
    quantity: int


class ConfirmInput(BaseModel):
    order_id: str
    expected_version: int = 1


class ConfirmOutput(BaseModel):
    order_id: str
    status: str
    version: int


@pytest.fixture(autouse=True)
def _jwt_secret(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setattr(settings, "jwt_secret", SECRET)
    yield
    app.state.agui_runtime = None


def _token(
    *, user: str = "u1", tenant: str = "t1", role: str = "MEMBER", perms: list[str] | None = None
) -> str:
    payload = {
        "sub": user,
        "tenantId": tenant,
        "role": role,
        "permissions": perms or ["order:read", "order:approve"],
        "exp": int(time.time()) + 300,
    }
    return jwt.encode(payload, SECRET, algorithm="HS256")


def _build_test_registry(order_version_tracker: dict[str, int], *,
                         backend_tokens: list[str] | None = None,
                         observed_bindings: list[object] | None = None) -> ToolRegistry:
    registry = ToolRegistry()

    async def h_read(ctx: ToolContext, inp: ReadInput) -> ReadOutput:
        return ReadOutput(quantity=42)

    async def p_confirm(ctx: ToolContext, inp: ConfirmInput) -> PreviewResult:
        cur_version = order_version_tracker.get(inp.order_id, 1)
        binding = None
        if backend_tokens is not None:
            backend_tokens.append(str(uuid.uuid4()))
            binding = {"previewToken": backend_tokens[-1]}
        return PreviewResult(
            target_type="sales_order",
            target_id=inp.order_id,
            target_version=cur_version,
            summary={"order_id": inp.order_id, "amount": 1000, "version": cur_version},
            execution_binding=binding,
        )

    async def h_confirm(ctx: ToolContext, inp: ConfirmInput) -> ConfirmOutput:
        if observed_bindings is not None:
            observed_bindings.append(ctx.approval.execution_binding if ctx.approval else None)
        # Sensitive tool: context.approval is mandatory
        cur_version = order_version_tracker.get(inp.order_id, 1)
        order_version_tracker[inp.order_id] = cur_version + 1
        return ConfirmOutput(
            order_id=inp.order_id,
            status="CONFIRMED",
            version=cur_version + 1,
        )

    registry.register(
        ToolSpec(
            name="get_stock",
            description="Check product stock",
            input_model=ReadInput,
            output_model=ReadOutput,
            handler=h_read,
            required_permission="stock:read",
            risk_level=RiskLevel.READ,
        )
    )
    registry.register(
        ToolSpec(
            name="confirm_order",
            description="Confirm a sales order",
            input_model=ConfirmInput,
            output_model=ConfirmOutput,
            handler=h_confirm,
            preview=p_confirm,
            required_permission="order:approve",
            risk_level=RiskLevel.WRITE,
        )
    )
    return registry


async def test_conversational_turn_routes_to_end():
    order_versions: dict[str, int] = {}
    registry = _build_test_registry(order_versions)
    model = FakeToolModel(messages=iter([AIMessage(content="Xin chào, tôi là LogiX Copilot!")]))
    graph = build_planner_graph(registry, InMemorySaver(), model=model)

    res = await graph.ainvoke(
        {"messages": [HumanMessage(content="Chào bạn")]},
        config={
            "configurable": {
                "thread_id": "t1",
                "tenant_id": "tenant-1",
                "user_id": "user-1",
                "role": "MEMBER",
                "permissions": ["stock:read"],
                "access_token": "token",
                "correlation_id": "corr-1",
            }
        },
    )
    assert res["messages"][-1].content == "Xin chào, tôi là LogiX Copilot!"
    assert res.get("step_count", 0) == 0


async def test_read_only_tool_execution_loop():
    order_versions: dict[str, int] = {}
    registry = _build_test_registry(order_versions)
    model = FakeToolModel(
        messages=iter(
            [
                AIMessage(
                    content="",
                    tool_calls=[
                        ToolCall(name="get_stock", args={"product_sku": "SKU-99"}, id="call_1")
                    ],
                ),
                AIMessage(content="Tồn kho hiện tại là 42 sản phẩm."),
            ]
        )
    )
    graph = build_planner_graph(registry, InMemorySaver(), model=model)

    res = await graph.ainvoke(
        {"messages": [HumanMessage(content="Kiểm tra tồn kho SKU-99")]},
        config={
            "configurable": {
                "thread_id": "t1",
                "tenant_id": "tenant-1",
                "user_id": "user-1",
                "role": "MEMBER",
                "permissions": ["stock:read"],
                "access_token": "token",
                "correlation_id": "corr-1",
            }
        },
    )
    # Result has: Human -> AI (tool_call) -> ToolMessage -> AI (final reply)
    messages = res["messages"]
    assert len(messages) >= 4
    tool_msg = messages[-2]
    assert tool_msg.type == "tool"
    assert json.loads(tool_msg.content)["quantity"] == 42
    assert messages[-1].content == "Tồn kho hiện tại là 42 sản phẩm."
    assert res.get("step_count", 0) == 1


async def test_sensitive_tool_interrupts_and_resumes_on_approval():
    order_id = str(uuid.uuid4())
    order_versions = {order_id: 1}
    backend_tokens: list[str] = []
    observed_bindings: list[object] = []
    registry = _build_test_registry(order_versions, backend_tokens=backend_tokens, observed_bindings=observed_bindings)
    confirmation_service = ConfirmationService(InMemoryConfirmationStore())
    checkpointer = InMemorySaver()

    model = FakeToolModel(
        messages=iter(
            [
                AIMessage(
                    content="",
                    tool_calls=[
                        ToolCall(name="confirm_order", args={"order_id": order_id}, id="call_1")
                    ],
                ),
                AIMessage(content="Đơn hàng đã được xác nhận thành công!"),
            ]
        )
    )
    graph = build_planner_graph(
        registry,
        checkpointer,
        model=model,
        confirmation_service=confirmation_service,
    )

    thread_cfg = {
        "configurable": {
            "thread_id": "thread-ord-1",
            "tenant_id": "tenant-1",
            "user_id": "user-1",
            "role": "MEMBER",
            "permissions": ["order:approve"],
            "access_token": "token",
            "correlation_id": "corr-1",
        }
    }

    # Turn 1: graph invokes tool, sees it is sensitive, calls preview and interrupts
    await graph.ainvoke(
        {"messages": [HumanMessage(content=f"Xác nhận đơn hàng {order_id}")]},
        config=thread_cfg,
    )

    state = await graph.aget_state(thread_cfg)
    assert len(state.tasks) > 0
    interrupts = state.tasks[0].interrupts
    assert len(interrupts) == 1
    interrupt_payload = interrupts[0].value
    assert interrupt_payload["action"] == "confirm_order"
    assert interrupt_payload["target_id"] == order_id
    assert interrupt_payload["target_version"] == 1
    assert "execution_binding" not in interrupt_payload
    approval_id = interrupt_payload["approval_id"]

    # Order has not been modified yet!
    assert order_versions[order_id] == 1

    # Turn 2: Human approves the confirmation request
    res = await graph.ainvoke(
        Command(resume={"approved": True, "approval_id": approval_id}),
        config=thread_cfg,
    )

    # Order was confirmed and updated to version 2!
    assert order_versions[order_id] == 2
    assert len(backend_tokens) == 2
    assert observed_bindings == [{"previewToken": backend_tokens[0]}]
    assert res["messages"][-1].content == "Đơn hàng đã được xác nhận thành công!"

    # Confirmation record is now CONSUMED
    rec = await confirmation_service.get_request("tenant-1", approval_id)
    assert rec is not None
    assert rec.status == "CONSUMED"


async def test_sensitive_tool_interrupts_and_cancels_on_rejection():
    order_id = str(uuid.uuid4())
    order_versions = {order_id: 1}
    registry = _build_test_registry(order_versions)
    confirmation_service = ConfirmationService(InMemoryConfirmationStore())
    checkpointer = InMemorySaver()

    model = FakeToolModel(
        messages=iter(
            [
                AIMessage(
                    content="",
                    tool_calls=[
                        ToolCall(name="confirm_order", args={"order_id": order_id}, id="call_1")
                    ],
                ),
                AIMessage(content="Đã hủy thao tác xác nhận đơn hàng theo yêu cầu."),
            ]
        )
    )
    graph = build_planner_graph(
        registry,
        checkpointer,
        model=model,
        confirmation_service=confirmation_service,
    )

    thread_cfg = {
        "configurable": {
            "thread_id": "thread-ord-reject",
            "tenant_id": "tenant-1",
            "user_id": "user-1",
            "role": "MEMBER",
            "permissions": ["order:approve"],
            "access_token": "token",
            "correlation_id": "corr-1",
        }
    }

    await graph.ainvoke(
        {"messages": [HumanMessage(content=f"Xác nhận đơn hàng {order_id}")]},
        config=thread_cfg,
    )

    # Resume with rejection
    res = await graph.ainvoke(
        Command(resume={"approved": False}),
        config=thread_cfg,
    )

    # Downstream order was NOT confirmed!
    assert order_versions[order_id] == 1
    assert res["messages"][-1].content == "Đã hủy thao tác xác nhận đơn hàng theo yêu cầu."


async def test_sensitive_tool_stale_version_aborts_execution():
    order_id = str(uuid.uuid4())
    order_versions = {order_id: 1}
    registry = _build_test_registry(order_versions)
    confirmation_service = ConfirmationService(InMemoryConfirmationStore())
    checkpointer = InMemorySaver()

    model = FakeToolModel(
        messages=iter(
            [
                AIMessage(
                    content="",
                    tool_calls=[
                        ToolCall(name="confirm_order", args={"order_id": order_id}, id="call_1")
                    ],
                ),
                AIMessage(content="Không thể xác nhận vì phiên bản đơn hàng đã bị thay đổi."),
            ]
        )
    )
    graph = build_planner_graph(
        registry,
        checkpointer,
        model=model,
        confirmation_service=confirmation_service,
    )

    thread_cfg = {
        "configurable": {
            "thread_id": "thread-ord-stale",
            "tenant_id": "tenant-1",
            "user_id": "user-1",
            "role": "MEMBER",
            "permissions": ["order:approve"],
            "access_token": "token",
            "correlation_id": "corr-1",
        }
    }

    await graph.ainvoke(
        {"messages": [HumanMessage(content=f"Xác nhận đơn hàng {order_id}")]},
        config=thread_cfg,
    )

    # External actor updates order to version 2 behind the scenes!
    order_versions[order_id] = 2

    # Human attempts to approve preview version 1
    res = await graph.ainvoke(
        Command(resume={"approved": True}),
        config=thread_cfg,
    )

    # Order remained at version 2, handler was not called!
    assert order_versions[order_id] == 2
    # Tool message warned about version mismatch
    tool_msg = res["messages"][-2]
    assert "phiên bản không khớp" in tool_msg.content
    assert res["messages"][-1].content == "Không thể xác nhận vì phiên bản đơn hàng đã bị thay đổi."


async def test_decisions_endpoint_via_http_client():
    order_id = str(uuid.uuid4())
    order_versions = {order_id: 1}
    registry = _build_test_registry(order_versions)
    confirmation_service = ConfirmationService(InMemoryConfirmationStore())

    model = FakeToolModel(
        messages=iter(
            [
                AIMessage(
                    content="",
                    tool_calls=[
                        ToolCall(name="confirm_order", args={"order_id": order_id}, id="call_1")
                    ],
                ),
                AIMessage(content="Đơn hàng đã được xác nhận qua endpoint decisions!"),
            ]
        )
    )

    app.state.agui_runtime = build_agui_runtime(
        model,
        registry=registry,
        confirmation_service=confirmation_service,
    )

    token = _token(user="user-1", tenant="tenant-1", perms=["order:approve"])
    headers = {"Authorization": f"Bearer {token}"}
    thread_id = "thread-decide-1"

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # 1. Post chat request to /api/v1/agent/runs
        body = {
            "threadId": thread_id,
            "runId": str(uuid.uuid4()),
            "state": {},
            "messages": [{"id": str(uuid.uuid4()), "role": "user", "content": "confirm order"}],
            "tools": [],
            "context": [],
            "forwardedProps": {},
        }
        res1 = await client.post("/api/v1/agent/runs", json=body, headers=headers)
        assert res1.status_code == 200

        # Parse SSE events from turn 1 to extract approval_id from on_interrupt
        events1 = [
            json.loads(line[len("data:") :].strip())
            for line in res1.text.splitlines()
            if line.startswith("data:")
        ]
        interrupt_events = [e for e in events1 if e.get("name") == "on_interrupt"]
        assert len(interrupt_events) == 1
        interrupt_data = (
            json.loads(interrupt_events[0]["value"])
            if isinstance(interrupt_events[0]["value"], str)
            else interrupt_events[0]["value"]
        )
        approval_id = interrupt_data["approval_id"]

        # 2. Call /api/v1/agent/executions/{id}/decisions with APPROVE
        decision_body = {
            "decision": "APPROVE",
            "approval_id": approval_id,
            "thread_id": thread_id,
        }
        res2 = await client.post(
            f"/api/v1/agent/executions/{body['runId']}/decisions",
            json=decision_body,
            headers=headers,
        )
        assert res2.status_code == 200

        events2 = [
            json.loads(line[len("data:") :].strip())
            for line in res2.text.splitlines()
            if line.startswith("data:")
        ]
        # Verify run completed
        assert events2[-1]["type"] == "RUN_FINISHED"
        assert order_versions[order_id] == 2
