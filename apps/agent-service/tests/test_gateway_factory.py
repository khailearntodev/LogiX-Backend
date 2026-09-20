"""Unit tests for create_model_gateway factory and health endpoint."""

import pytest
from httpx import ASGITransport, AsyncClient

from logix_agent.config import AgentSettings, settings as app_settings
from logix_agent.main import app, get_model_gateway
from logix_agent.modules.ai.adapters.fake_gateway import FakeModelGateway
from logix_agent.modules.ai.adapters.gemini_gateway import GeminiModelGateway
from logix_agent.modules.ai.factory import create_model_gateway
from logix_agent.modules.ai.policies import (
    CapabilityCheckingModelGateway,
    RetryingModelGateway,
)
from logix_agent.modules.ai.ports import ModelGateway


def _adapter(gateway):
    """Unwrap the policy decorators to reach the provider adapter."""
    assert isinstance(gateway, RetryingModelGateway)
    assert isinstance(gateway.inner, CapabilityCheckingModelGateway)
    return gateway.inner.inner


def test_factory_creates_fake_gateway():
    settings = AgentSettings(llm_gateway_backend="fake")
    gw = create_model_gateway(settings)
    assert isinstance(gw, ModelGateway)
    assert isinstance(_adapter(gw), FakeModelGateway)


def test_factory_creates_gemini_gateway():
    settings = AgentSettings(
        llm_gateway_backend="gemini",
        gemini_api_key="test_api_key",
        planner_default_model="gemini-2.5-flash",
    )
    gw = create_model_gateway(settings)
    assert isinstance(gw, ModelGateway)
    assert isinstance(_adapter(gw), GeminiModelGateway)


def test_factory_unsupported_backend_raises():
    settings = AgentSettings(llm_gateway_backend="unknown_provider")
    with pytest.raises(ValueError) as exc_info:
        create_model_gateway(settings)
    assert "Unsupported llm_gateway_backend" in str(exc_info.value)


@pytest.mark.asyncio
async def test_health_ai_reports_gateway_configuration():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/health/ai")

    assert response.status_code == 200
    data = response.json()
    assert data["backend"] == app_settings.llm_gateway_backend
    assert data["default_model"] == app_settings.planner_default_model
    assert data["fallback_enabled"] == app_settings.llm_fallback_enabled
    assert data["status"] in {"configured", "uninitialized"}


def test_get_model_gateway_builds_composed_stack():
    gateway = get_model_gateway()
    assert isinstance(gateway, ModelGateway)
    _adapter(gateway)
