from __future__ import annotations

from datetime import UTC, datetime
from uuid import uuid4

import pytest

from logix_agent.config import AgentSettings
from logix_agent.modules.ai.contracts import (
    FinishReason,
    ModelRequest,
    ModelResponse,
    ModelUsage,
)
from logix_agent.modules.ai.ports import ModelGateway
from logix_agent.modules.provider_configs.models import LlmProviderConfig
from logix_agent.modules.provider_configs.tenant_gateway import (
    TenantAwareModelGateway,
    TenantModelConfigurationError,
)


class _Repository:
    def __init__(self, rows: dict[str, LlmProviderConfig]) -> None:
        self.rows = rows

    async def get_active(self, tenant_id: str) -> LlmProviderConfig | None:
        return self.rows.get(tenant_id)


def _row(model: str) -> LlmProviderConfig:
    now = datetime.now(UTC)
    return LlmProviderConfig(
        id=uuid4(),
        tenant_id=uuid4(),
        provider="fake",
        model=model,
        parameters={},
        version=1,
        is_active=True,
        created_at=now,
        updated_at=now,
    )


def _request(tenant: str, execution: str) -> ModelRequest:
    return ModelRequest(
        model_profile="planner-default",
        tenant_id=tenant,
        correlation_id=f"corr-{execution}",
        execution_id=execution,
        messages=[{"role": "user", "content": "hello"}],
    )


@pytest.mark.asyncio
async def test_gateway_binds_config_to_execution_and_isolates_tenants() -> None:
    rows = {"tenant-a": _row("model-a"), "tenant-b": _row("model-b")}
    factory_models: list[str] = []

    def factory(config: AgentSettings) -> ModelGateway:
        factory_models.append(config.planner_default_model)

        async def response(request: ModelRequest, **_: object) -> ModelResponse:
            return ModelResponse(
                provider="fake",
                model=config.planner_default_model,
                model_profile=request.model_profile,
                gateway_backend="fake",
                content=config.planner_default_model,
                finish_reason=FinishReason.STOP,
                usage=ModelUsage(),
            )

        class _Gateway:
            async def generate(self, request: ModelRequest, *, tools=()):
                return await response(request, tools=tools)

            async def stream(self, request: ModelRequest, *, tools=()):
                if False:
                    yield request  # pragma: no cover

        return _Gateway()

    gateway = TenantAwareModelGateway(
        _Repository(rows),
        settings=AgentSettings(environment="test"),
        gateway_factory=factory,
    )

    await gateway.begin_execution("tenant-a", "execution-a")
    rows["tenant-a"].model = "model-a-updated"
    first = await gateway.generate(_request("tenant-a", "execution-a"))
    other = await gateway.generate(_request("tenant-b", "execution-b"))

    assert first.content == "model-a"
    assert other.content == "model-b"
    assert factory_models == ["model-a", "model-b"]

    gateway.release_execution("tenant-a", "execution-a")
    refreshed = await gateway.begin_execution("tenant-a", "execution-a-2")
    assert refreshed.model == "model-a-updated"


@pytest.mark.asyncio
async def test_gateway_fails_closed_when_tenant_has_no_config() -> None:
    gateway = TenantAwareModelGateway(
        _Repository({}),
        settings=AgentSettings(environment="test"),
    )

    with pytest.raises(TenantModelConfigurationError) as error:
        await gateway.generate(_request("tenant-missing", "execution"))

    assert error.value.code == "MODEL_CONFIG_REQUIRED"
