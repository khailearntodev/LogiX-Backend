from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest

from logix_agent.modules.provider_configs.models import LlmProviderConfig
from logix_agent.modules.provider_configs.repository import (
    ProviderConfigVersionConflictError,
    SqlAlchemyProviderConfigRepository,
)


class _SessionContext:
    def __init__(self, session: _FakeSession) -> None:
        self._session = session

    async def __aenter__(self) -> _FakeSession:
        return self._session

    async def __aexit__(self, *_: object) -> None:
        return None


class _FakeSession:
    def __init__(self, row: LlmProviderConfig | None) -> None:
        self.row = row
        self.added: list[LlmProviderConfig] = []
        self.commits = 0
        self.rollbacks = 0

    async def scalar(self, _statement: object) -> LlmProviderConfig | None:
        return self.row

    def add(self, row: LlmProviderConfig) -> None:
        self.added.append(row)
        self.row = row

    async def flush(self) -> None:
        if self.row is not None and self.row.created_at is None:
            self.row.created_at = datetime.now(timezone.utc)
            self.row.updated_at = self.row.created_at

    async def refresh(self, _row: LlmProviderConfig) -> None:
        return None

    async def commit(self) -> None:
        self.commits += 1

    async def rollback(self) -> None:
        self.rollbacks += 1


class _Factory:
    def __init__(self, session: _FakeSession) -> None:
        self.session = session

    def __call__(self) -> _SessionContext:
        return _SessionContext(self.session)


def _row(*, tenant_id: UUID, version: int = 1) -> LlmProviderConfig:
    now = datetime.now(timezone.utc)
    return LlmProviderConfig(
        id=uuid4(),
        tenant_id=tenant_id,
        provider="gemini",
        model="gemini-3.8-flash",
        parameters={"timeout_seconds": 30},
        is_active=True,
        version=version,
        created_at=now,
        updated_at=now,
    )


@pytest.mark.asyncio
async def test_save_active_creates_tenant_config_with_expected_initial_state() -> None:
    tenant_id = uuid4()
    session = _FakeSession(None)
    repository = SqlAlchemyProviderConfigRepository(_Factory(session))

    row = await repository.save_active(
        tenant_id=str(tenant_id),
        provider="openai",
        model="openai/gpt-4o-mini",
        parameters={"timeout_seconds": 20},
        expected_version=0,
    )

    assert row.tenant_id == tenant_id
    assert row.provider == "openai"
    assert row.model == "openai/gpt-4o-mini"
    assert row.parameters == {"timeout_seconds": 20}
    assert session.commits == 1
    assert session.rollbacks == 0


@pytest.mark.asyncio
async def test_save_active_rejects_stale_version_without_commit() -> None:
    tenant_id = uuid4()
    session = _FakeSession(_row(tenant_id=tenant_id, version=3))
    repository = SqlAlchemyProviderConfigRepository(_Factory(session))

    with pytest.raises(ProviderConfigVersionConflictError):
        await repository.save_active(
            tenant_id=tenant_id,
            provider="openai",
            model="openai/gpt-4o-mini",
            expected_version=2,
        )

    assert session.commits == 0
    assert session.rollbacks == 1


@pytest.mark.asyncio
async def test_get_active_is_tenant_scoped() -> None:
    tenant_id = uuid4()
    session = _FakeSession(_row(tenant_id=tenant_id))
    repository = SqlAlchemyProviderConfigRepository(_Factory(session))

    result = await repository.get_active(tenant_id)

    assert result is session.row
