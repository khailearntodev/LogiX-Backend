"""Tenant-scoped persistence for the single active model configuration."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlalchemy.orm.exc import StaleDataError

from logix_agent.modules.provider_configs.models import LlmProviderConfig


class ProviderConfigError(RuntimeError):
    """Base error for provider configuration persistence operations."""


class ProviderConfigVersionConflictError(ProviderConfigError):
    """The caller attempted to update a stale configuration version."""


def _tenant_uuid(tenant_id: UUID | str) -> UUID:
    if isinstance(tenant_id, UUID):
        return tenant_id
    try:
        return UUID(str(tenant_id))
    except (TypeError, ValueError) as exc:
        raise ValueError("tenant_id must be a valid UUID") from exc


class SqlAlchemyProviderConfigRepository:
    """Repository that enforces tenant scope and optimistic updates.

    The partial unique index is the final concurrency guard. The update path
    also locks the active row so stale admin writes fail before commit with a
    stable domain error rather than leaking a database exception.
    """

    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._session_factory = session_factory

    async def get_active(
        self, tenant_id: UUID | str
    ) -> LlmProviderConfig | None:
        tenant_uuid = _tenant_uuid(tenant_id)
        async with self._session_factory() as session:
            return await session.scalar(
                select(LlmProviderConfig).where(
                    LlmProviderConfig.tenant_id == tenant_uuid,
                    LlmProviderConfig.is_active.is_(True),
                    LlmProviderConfig.deleted_at.is_(None),
                )
            )

    async def save_active(
        self,
        *,
        tenant_id: UUID | str,
        provider: str,
        model: str,
        parameters: Mapping[str, Any] | None = None,
        expected_version: int | None = None,
    ) -> LlmProviderConfig:
        """Create/update the one active tenant config atomically.

        ``expected_version`` is ``None`` or ``0`` for first creation and must
        equal the stored version for an update. The caller owns provider/model
        allow-list validation; this repository only owns persistence invariants.
        """

        tenant_uuid = _tenant_uuid(tenant_id)
        if expected_version is not None and expected_version < 0:
            raise ValueError("expected_version must be non-negative")

        async with self._session_factory() as session:
            try:
                row = await session.scalar(
                    select(LlmProviderConfig)
                    .where(
                        LlmProviderConfig.tenant_id == tenant_uuid,
                        LlmProviderConfig.is_active.is_(True),
                        LlmProviderConfig.deleted_at.is_(None),
                    )
                    .with_for_update()
                )

                if row is None:
                    if expected_version not in (None, 0):
                        raise ProviderConfigVersionConflictError(
                            "Provider configuration was created by another writer"
                        )
                    row = LlmProviderConfig(
                        tenant_id=tenant_uuid,
                        provider=provider,
                        model=model,
                        parameters=dict(parameters or {}),
                        is_active=True,
                    )
                    session.add(row)
                else:
                    if expected_version is None or row.version != expected_version:
                        raise ProviderConfigVersionConflictError(
                            "Provider configuration version is stale"
                        )
                    row.provider = provider
                    row.model = model
                    row.parameters = dict(parameters or {})
                    row.is_active = True
                    row.deleted_at = None

                await session.flush()
                await session.refresh(row)
                await session.commit()
                return row
            except ProviderConfigVersionConflictError:
                await session.rollback()
                raise
            except (IntegrityError, StaleDataError) as exc:
                await session.rollback()
                raise ProviderConfigVersionConflictError(
                    "Provider configuration could not be updated because its version changed"
                ) from exc
            except Exception:
                await session.rollback()
                raise
