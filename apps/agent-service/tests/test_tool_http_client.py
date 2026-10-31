"""ServiceClient: auth forwarding, retry policy and error normalization."""

from __future__ import annotations

import httpx
import pytest

from logix_agent.config import AgentSettings
from logix_agent.modules.auth import Actor
from logix_agent.modules.registry import ToolContext, ToolError
from logix_agent.modules.tools.http_client import ServiceClient, create_service_client


def _ctx(token: str | None = "tok") -> ToolContext:
    return ToolContext(
        actor=Actor(user_id="u1", tenant_id="t1", access_token=token),
        correlation_id="corr-1",
    )


def _client(handler: httpx.MockTransport | None = None, **kwargs: object) -> ServiceClient:
    return ServiceClient(
        base_urls={"inventory": "http://inventory.test/"},
        backoff_seconds=0,
        transport=handler,
        **kwargs,  # type: ignore[arg-type]
    )


async def test_forwards_token_and_correlation_id() -> None:
    seen: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(request.headers)
        seen["url"] = str(request.url)
        return httpx.Response(200, json={"ok": True})

    client = _client(httpx.MockTransport(handler))
    result = await client.request(
        "inventory", "GET", "/api/v1/inventory/balances", _ctx(), params={"sku": "A"}
    )

    assert result == {"ok": True}
    assert seen["authorization"] == "Bearer tok"
    assert seen["x-correlation-id"] == "corr-1"
    assert seen["url"] == "http://inventory.test/api/v1/inventory/balances?sku=A"


async def test_missing_token_is_rejected_without_calling_service() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("must not be called")

    client = _client(httpx.MockTransport(handler))
    with pytest.raises(ToolError) as exc:
        await client.request("inventory", "GET", "/x", _ctx(token=None))
    assert exc.value.code == "TOOL_UNAUTHORIZED"


async def test_unknown_service() -> None:
    client = _client(httpx.MockTransport(lambda r: httpx.Response(200)))
    with pytest.raises(ToolError) as exc:
        await client.request("orders", "GET", "/x", _ctx())
    assert exc.value.code == "TOOL_NOT_CONFIGURED"


@pytest.mark.parametrize(
    ("service", "setting"),
    [
        ("identity", "identity_service_url"),
        ("order", "order_service_url"),
        ("master_data", "master_data_service_url"),
        ("inventory", "inventory_service_url"),
        ("fulfillment", "fulfillment_service_url"),
        ("transport", "transport_service_url"),
        ("route_optimizer", "route_optimizer_service_url"),
        ("forecast", "forecast_service_url"),
    ],
)
async def test_factory_preserves_service_configuration(service: str, setting: str) -> None:
    settings = AgentSettings(**{setting: f"http://{service.replace('_', '-')}.test/"})
    client = create_service_client(settings)
    try:
        assert client._base_urls[service] == f"http://{service.replace('_', '-')}.test"
    finally:
        await client.aclose()


@pytest.mark.parametrize(
    ("status", "code"),
    [
        (401, "TOOL_UNAUTHORIZED"),
        (403, "TOOL_FORBIDDEN"),
        (404, "TOOL_NOT_FOUND"),
        (409, "TOOL_CONFLICT"),
        (422, "TOOL_INVALID_REQUEST"),
        (500, "TOOL_UNAVAILABLE"),
    ],
)
async def test_status_mapping_without_retry(status: int, code: str) -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(status, json={"message": "internal detail"})

    client = _client(httpx.MockTransport(handler))
    with pytest.raises(ToolError) as exc:
        await client.request("inventory", "GET", "/x", _ctx())

    assert exc.value.code == code
    assert "internal detail" not in str(exc.value)
    assert calls == 1


async def test_get_retries_on_503_then_succeeds() -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(503) if calls == 1 else httpx.Response(200, json={"n": 1})

    client = _client(httpx.MockTransport(handler), max_attempts=2)
    assert await client.request("inventory", "GET", "/x", _ctx()) == {"n": 1}
    assert calls == 2


async def test_get_gives_up_after_max_attempts() -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        raise httpx.ConnectTimeout("slow")

    client = _client(httpx.MockTransport(handler), max_attempts=3)
    with pytest.raises(ToolError) as exc:
        await client.request("inventory", "GET", "/x", _ctx())
    assert exc.value.code == "TOOL_TIMEOUT"
    assert calls == 3


async def test_post_is_never_retried() -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(503)

    client = _client(httpx.MockTransport(handler), max_attempts=3)
    with pytest.raises(ToolError) as exc:
        await client.request("inventory", "POST", "/x", _ctx(), json={"a": 1})
    assert exc.value.code == "TOOL_UNAVAILABLE"
    assert calls == 1


async def test_connection_error_is_unavailable() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    client = _client(httpx.MockTransport(handler), max_attempts=1)
    with pytest.raises(ToolError) as exc:
        await client.request("inventory", "GET", "/x", _ctx())
    assert exc.value.code == "TOOL_UNAVAILABLE"


async def test_empty_and_invalid_bodies() -> None:
    client = _client(httpx.MockTransport(lambda r: httpx.Response(204)))
    assert await client.request("inventory", "GET", "/x", _ctx()) is None

    client = _client(httpx.MockTransport(lambda r: httpx.Response(200, text="<html>")))
    with pytest.raises(ToolError) as exc:
        await client.request("inventory", "GET", "/x", _ctx())
    assert exc.value.code == "TOOL_BAD_RESPONSE"
