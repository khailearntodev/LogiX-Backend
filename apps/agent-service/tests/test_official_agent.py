"""create_agent flow: tool loop, identity from the token, error handling, AG-UI endpoint."""

from __future__ import annotations

import json
import logging
import time
import uuid
from collections.abc import Iterator

import httpx
import jwt
import pytest
from ag_ui.core import RunErrorEvent
from httpx import ASGITransport, AsyncClient
from langchain.messages import AIMessage, HumanMessage, ToolCall
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langgraph.checkpoint.memory import InMemorySaver

from logix_agent.config import settings
from logix_agent.main import app
from logix_agent.modules.agent import tools as agent_tools
from logix_agent.modules.agent.graph import build_agent
from logix_agent.modules.agent.router import _sanitize, build_official_runtime
from logix_agent.modules.agent.run_logging import RunLogHandler

SECRET = "test-secret"
PRODUCT_ID = str(uuid.uuid4())


class FakeToolCallingModel(GenericFakeChatModel):
    # create_agent calls bind_tools; the fake model ignores the tools (pattern from LangChain's unit-testing docs).
    def bind_tools(self, tools, **kwargs):  # type: ignore[no-untyped-def]
        return self


def _tool_call_turn(name: str, args: dict[str, object]) -> AIMessage:
    return AIMessage(content="", tool_calls=[ToolCall(name=name, args=args, id="call_1")])


def _product_page() -> dict[str, object]:
    return {
        "items": [
            {
                "id": PRODUCT_ID,
                "sku": "SKU-1",
                "name": "Widget",
                "baseUnit": "PCS",
                "weight": "1.000",
                "volume": "0.001000",
                "status": "ACTIVE",
                "createdAt": "2026-01-01T00:00:00Z",
                "internalNote": "must not reach the model",
            }
        ],
        "page": 1,
        "pageSize": 10,
        "total": 1,
    }


def _mock_services(monkeypatch: pytest.MonkeyPatch, handler) -> None:  # type: ignore[no-untyped-def]
    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        agent_tools.httpx,
        "AsyncClient",
        lambda **kwargs: real_client(transport=httpx.MockTransport(handler), **kwargs),
    )


async def _ask(
    model: FakeToolCallingModel, text: str = "list products", callbacks: list | None = None
) -> dict:
    agent = build_agent(InMemorySaver(), model=model)
    return await agent.ainvoke(
        {"messages": [HumanMessage(content=text)]},
        config={
            "callbacks": callbacks or [],
            "configurable": {
                "thread_id": "t1",
                "tenant_id": "tenant-1",
                "access_token": "user-token",
                "correlation_id": "corr-1",
            },
        },
    )


async def test_tool_call_uses_caller_token_and_filters_fields(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=_product_page())

    _mock_services(monkeypatch, handler)
    model = FakeToolCallingModel(
        messages=iter(
            [_tool_call_turn("list_products", {"q": "wid"}), AIMessage(content="Found Widget")]
        )
    )

    result = await _ask(model)

    request = seen[0]
    assert request.url.path == "/api/v1/products"
    assert dict(request.url.params) == {"q": "wid", "page": "1", "pageSize": "10"}
    assert request.headers["authorization"] == "Bearer user-token"
    assert request.headers["x-correlation-id"] == "corr-1"
    tool_message = result["messages"][-2]
    payload = json.loads(tool_message.content)
    assert set(payload["items"][0]) == {
        "id",
        "sku",
        "name",
        "baseUnit",
        "weight",
        "volume",
        "status",
    }
    assert "internalNote" not in tool_message.content
    assert result["messages"][-1].text == "Found Widget"


async def test_low_stock_flag_is_only_sent_when_true(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"items": [], "page": 1, "pageSize": 10, "total": 0})

    _mock_services(monkeypatch, handler)
    model = FakeToolCallingModel(
        messages=iter(
            [
                _tool_call_turn("list_inventory_balances", {"low_stock_only": True}),
                AIMessage(content="ok"),
            ]
        )
    )
    await _ask(model)
    assert seen[0].url.path == "/api/v1/inventory/balances"
    assert seen[0].url.params["lowStockOnly"] == "true"

    seen.clear()
    model = FakeToolCallingModel(
        messages=iter([_tool_call_turn("list_inventory_balances", {}), AIMessage(content="ok")])
    )
    await _ask(model)
    assert "lowStockOnly" not in seen[0].url.params


async def test_forbidden_becomes_a_message_the_model_can_read(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(403, json={"message": "secret internal detail"})

    _mock_services(monkeypatch, handler)
    warehouse = str(uuid.uuid4())
    model = FakeToolCallingModel(
        messages=iter(
            [
                _tool_call_turn(
                    "get_inventory_balance",
                    {"warehouse_id": warehouse, "product_id": PRODUCT_ID},
                ),
                AIMessage(content="You are not allowed"),
            ]
        )
    )

    result = await _ask(model)

    tool_message = result["messages"][-2]
    assert tool_message.status == "error"
    assert "quyền" in tool_message.content
    assert "secret internal detail" not in tool_message.content
    assert calls == 1  # 4xx is not retried


async def test_timeouts_are_retried_then_reported(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        raise httpx.ConnectTimeout("slow")

    _mock_services(monkeypatch, handler)
    model = FakeToolCallingModel(
        messages=iter([_tool_call_turn("list_products", {}), AIMessage(content="sorry")])
    )

    result = await _ask(model)

    assert calls == 3
    assert "quá lâu" in result["messages"][-2].content


# ── AG-UI endpoint ───────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _auth_secret(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setattr(settings, "jwt_secret", SECRET)
    yield
    app.state.official_runtime = None


def _token() -> str:
    payload = {"sub": "user-1", "tenantId": "tenant-1", "exp": int(time.time()) + 300}
    return jwt.encode(payload, SECRET, algorithm="HS256")


def _body(thread_id: str, text: str, **extra: object) -> dict[str, object]:
    return {
        "threadId": thread_id,
        "runId": str(uuid.uuid4()),
        "state": {},
        "messages": [{"id": str(uuid.uuid4()), "role": "user", "content": text}],
        "tools": [],
        "context": [],
        "forwardedProps": {},
        **extra,
    }


async def _post(body: dict[str, object], token: str | None) -> tuple[int, list[dict]]:
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/api/v1/agent/official/runs", json=body, headers=headers)
    events = [
        json.loads(line[len("data:") :].strip())
        for line in response.text.splitlines()
        if line.startswith("data:")
    ]
    return response.status_code, events


async def test_endpoint_requires_a_token() -> None:
    app.state.official_runtime = build_official_runtime(
        FakeToolCallingModel(messages=iter([AIMessage(content="hi")]))
    )
    status, _ = await _post(_body("thread-aaaa1111", "hello"), None)
    assert status == 401


async def test_endpoint_streams_the_answer(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.INFO, logger="logix_agent")
    app.state.official_runtime = build_official_runtime(
        FakeToolCallingModel(messages=iter([AIMessage(content="Xin chào")]))
    )
    status, events = await _post(_body("thread-aaaa1111", "hello"), _token())

    lines = [r.getMessage() for r in caplog.records]
    assert any("agent run started" in line and "tenant=tenant-1" in line for line in lines)
    assert any("agent run ended in" in line for line in lines)

    types = [e["type"] for e in events]
    assert status == 200
    assert types[0] == "RUN_STARTED" and types[-1] == "RUN_FINISHED"
    assert "".join(e["delta"] for e in events if e["type"] == "TEXT_MESSAGE_CONTENT") == "Xin chào"


async def test_model_failure_shows_a_safe_message() -> None:
    # An exhausted fake model raises inside the run.
    app.state.official_runtime = build_official_runtime(FakeToolCallingModel(messages=iter([])))
    status, _ = await _post(_body("thread-aaaa1111", "hello"), _token())
    assert status == 200

    result = await _ask(FakeToolCallingModel(messages=iter([])))
    answer = result["messages"][-1].text
    assert answer == "Mô hình AI hiện không khả dụng. Vui lòng thử lại sau."
    assert "StopIteration" not in answer and "RuntimeError" not in answer


async def test_model_and_tool_activity_is_logged(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.INFO, logger="logix_agent")
    _mock_services(monkeypatch, lambda r: httpx.Response(200, json=_product_page()))
    model = FakeToolCallingModel(
        messages=iter([_tool_call_turn("list_products", {"q": "wid"}), AIMessage(content="Found")])
    )

    await _ask(model, callbacks=[RunLogHandler("run=abc tenant=tenant-1")])

    lines = [r.getMessage() for r in caplog.records]
    assert sum("run=abc tenant=tenant-1 model call started" in line for line in lines) == 2
    assert sum("model call finished" in line for line in lines) == 2
    assert any("tool list_products started args=" in line and "wid" in line for line in lines)
    assert any("tool list_products finished in" in line for line in lines)
    assert any(line.startswith("GET /api/v1/products -> 200") for line in lines)


async def test_failed_tool_is_logged_as_a_warning(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.INFO, logger="logix_agent")
    _mock_services(monkeypatch, lambda r: httpx.Response(403))
    model = FakeToolCallingModel(
        messages=iter([_tool_call_turn("list_products", {}), AIMessage(content="no")])
    )

    await _ask(model, callbacks=[RunLogHandler("run=abc tenant=t")])

    warnings = [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING]
    assert any("tool list_products failed" in w and "HTTPStatusError" in w for w in warnings)


async def test_unexpected_tool_errors_are_generic_for_the_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A response without "items" raises KeyError inside the tool.
    _mock_services(monkeypatch, lambda r: httpx.Response(200, json={"unexpected": True}))
    model = FakeToolCallingModel(
        messages=iter([_tool_call_turn("list_products", {}), AIMessage(content="sorry")])
    )

    result = await _ask(model)

    tool_message = result["messages"][-2]
    assert tool_message.status == "error"
    assert "KeyError" not in tool_message.content and "items" not in tool_message.content


def test_run_error_events_are_replaced_with_a_generic_message() -> None:
    event = RunErrorEvent(message="[boom] secret internal detail", code="X")
    sanitized = _sanitize(event)
    assert sanitized.message == "Đã xảy ra lỗi khi xử lý yêu cầu."
    assert sanitized.code == "INTERNAL"


async def test_client_forwarded_props_cannot_drive_the_run() -> None:
    app.state.official_runtime = build_official_runtime(
        FakeToolCallingModel(messages=iter([AIMessage(content="ok")]))
    )
    body = _body("thread-aaaa1111", "hello", forwardedProps={"command": {"resume": "approve"}})
    status, events = await _post(body, _token())

    assert status == 200
    assert [e["type"] for e in events][-1] == "RUN_FINISHED"


async def test_thread_belongs_to_its_first_user() -> None:
    app.state.official_runtime = build_official_runtime(
        FakeToolCallingModel(messages=iter([AIMessage(content="a"), AIMessage(content="b")]))
    )
    await _post(_body("thread-aaaa1111", "hello"), _token())
    other = jwt.encode(
        {"sub": "user-2", "tenantId": "tenant-1", "exp": int(time.time()) + 300},
        SECRET,
        algorithm="HS256",
    )
    status, _ = await _post(_body("thread-aaaa1111", "hello"), other)
    assert status == 404
