"""Store factory for cross-thread long-term agent memory persistence."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from langgraph.store.base import BaseStore
from langgraph.store.memory import InMemoryStore

from logix_agent.config import AgentSettings
from logix_agent.modules.planner.checkpointer import open_postgres_pool

logger = logging.getLogger(__name__)


@asynccontextmanager
async def open_store(settings: AgentSettings) -> AsyncIterator[BaseStore]:
    """Open the long-term memory store for the app lifetime and release it on exit.

    Development (or no ``DATABASE_URL``) uses ``InMemoryStore``.  Every other
    environment requires Postgres: a failure raises instead of silently falling
    back to volatile memory.
    """
    if settings.environment == "development" or not settings.database_url:
        logger.info("Using InMemoryStore for development/testing.")
        yield InMemoryStore()
        return

    from langgraph.store.postgres import AsyncPostgresStore

    async with open_postgres_pool(settings.database_url, max_size=5, label="store") as pool:
        store = AsyncPostgresStore(conn=pool)
        try:
            await store.setup()  # idempotent: creates/migrates LangGraph store tables
        except Exception as exc:
            raise RuntimeError(f"Failed to initialize Postgres store: {exc}") from exc
        logger.info("Using AsyncPostgresStore.")
        yield store
