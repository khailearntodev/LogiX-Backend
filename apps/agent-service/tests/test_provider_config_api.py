from __future__ import annotations

import time
import uuid
from datetime import UTC, datetime

import jwt
import pytest
from httpx import ASGITransport, AsyncClient

from logix_agent.config import AgentSettings, settings
from logix_agent.main import app
from logix_agent.modules.ai.adapters.fake_gateway import FakeModelGateway
from logix_agent.modules.provider_configs.models import LlmProviderConfig
from logix_agent.modules.provider_configs.router import get_provider_config_service
from logix_agent.modules.provider_configs.service import ProviderConfigService

SECRET = "provider-config-test-secret"


class _MemoryRepository:
    def __init__(self) -> None:
        self.rows: dict[str, LlmProviderConfig] = {}

    async def get_active(self, tenant_id: str) -> LlmProviderConfig | None:
        return self.rows.get(tenant_id)

    async def save_active(
        self,
        *,
        tenant_id: str,
        provider: str,
        model: str,
        parameters: dict[str, object] | None = None,
        expected_version: int | None = None,
    ) -> LlmProviderConfig:
        from logix_agent.modules.provider_configs.repository import ProviderConfigVersionConflictError

        current = self.rows.get(tenant_id)
        if current is None:
            if expected_version not in (None, 0):
                raise ProviderConfigVersionConflictError
            current = LlmProviderConfig(
                id=uuid.uuid4(),
                tenant_id=uuid.uuid4(),
                provider=provider,
                model=model,
                parameters=dict(parameters or {}),
                is_active=True,
                version=1,
                created_at=datetime.now(UTC),
                updated_at=datetime.now(UTC),
            )
            self.rows[tenant_id] = current
            return current
        if expected_version != current.version:
            raise ProviderConfigVersionConflictError
        current.provider = provider
        current.model = model
        current.parameters = dict(parameters or {})
        current.version += 1
        current.updated_at = datetime.now(UTC)
        return current


def _token(*, tenant: str, role: str = "MEMBER", permissions: list[str] | None = None) -> str:
    return jwt.encode(
        {
            "sub": str(uuid.uuid4()),
            "tenantId": tenant,
            "role": role,
            "permissions": permissions or [],
            "exp": int(time.time()) + 300,
        },
        SECRET,
        algorithm="HS256",
    )


@pytest.fixture(autouse=True)
def _configured_api(monkeypatch: pytest.MonkeyPatch):
    repository = _MemoryRepository()
    service = ProviderConfigService(
        repository,
        settings=AgentSettings(environment="test", gemini_api_key="gemini-test-key"),
        gateway_factory=lambda _: FakeModelGateway.echo(),
    )
    monkeypatch.setattr(settings, "jwt_secret", SECRET)
    app.dependency_overrides[get_provider_config_service] = lambda: service
    yield repository
    app.dependency_overrides.pop(get_provider_config_service, None)


async def _request(method: str, path: str, *, token: str | None = None, body: object = None):
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.request(method, path, json=body, headers=headers)


@pytest.mark.asyncio
async def test_model_config_requires_authentication() -> None:
    response = await _request("GET", "/api/v1/agent/model-config")
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_member_cannot_update_model_config() -> None:
    tenant = str(uuid.uuid4())
    response = await _request(
        "PUT",
        "/api/v1/agent/model-config",
        token=_token(tenant=tenant),
        body={"provider": "fake", "model": "fake-model", "expectedVersion": 0},
    )
    assert response.status_code == 403


@pytest.mark.asyncio
async def test_owner_can_save_and_read_only_their_tenant() -> None:
    tenant_a = str(uuid.uuid4())
    tenant_b = str(uuid.uuid4())
    owner = _token(tenant=tenant_a, role="OWNER")

    saved = await _request(
        "PUT",
        "/api/v1/agent/model-config",
        token=owner,
        body={
            "provider": "fake",
            "model": "fake-model",
            "parameters": {"timeoutSeconds": 20},
            "expectedVersion": 0,
        },
    )
    assert saved.status_code == 200
    assert saved.json()["provider"] == "fake"
    assert saved.json()["parameters"] == {"timeoutSeconds": 20}
    assert "apiKey" not in saved.text and "gemini-test-key" not in saved.text

    other = await _request(
        "GET", "/api/v1/agent/model-config", token=_token(tenant=tenant_b)
    )
    assert other.status_code == 200
    assert other.json()["configured"] is False


@pytest.mark.asyncio
async def test_update_rejects_missing_provider_key_and_invalid_model() -> None:
    tenant = str(uuid.uuid4())
    owner = _token(tenant=tenant, role="OWNER")

    missing_key = await _request(
        "PUT",
        "/api/v1/agent/model-config",
        token=owner,
        body={"provider": "openai", "model": "openai/gpt-4o-mini"},
    )
    assert missing_key.status_code == 422
    assert missing_key.json()["message"] == "MODEL_CONFIG_PROVIDER_NOT_CONFIGURED"

    invalid_model = await _request(
        "PUT",
        "/api/v1/agent/model-config",
        token=owner,
        body={"provider": "gemini", "model": "openai/gpt-4o-mini"},
    )
    assert invalid_model.status_code == 422
    assert invalid_model.json()["message"] == "MODEL_CONFIG_INVALID"


@pytest.mark.asyncio
async def test_update_uses_optimistic_version_and_test_does_not_write() -> None:
    tenant = str(uuid.uuid4())
    owner = _token(tenant=tenant, role="OWNER")
    first = await _request(
        "PUT",
        "/api/v1/agent/model-config",
        token=owner,
        body={"provider": "fake", "model": "fake-model", "expectedVersion": 0},
    )
    assert first.json()["version"] == 1

    test_response = await _request(
        "POST",
        "/api/v1/agent/model-config/test",
        token=owner,
        body={"provider": "fake", "model": "fake-model"},
    )
    assert test_response.status_code == 200
    assert test_response.json()["ok"] is True

    stale = await _request(
        "PUT",
        "/api/v1/agent/model-config",
        token=owner,
        body={"provider": "fake", "model": "other-model", "expectedVersion": 0},
    )
    assert stale.status_code == 409
    assert stale.json()["message"] == "MODEL_CONFIG_VERSION_CONFLICT"
