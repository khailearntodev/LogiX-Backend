"""Checkpointer factory for planner graph state persistence."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.checkpoint.memory import InMemorySaver

from logix_agent.config import AgentSettings

logger = logging.getLogger(__name__)


def _psycopg_conninfo(database_url: str) -> str:
    """LangGraph's Postgres persistence uses psycopg, not the asyncpg driver of the ORM URL."""
    return database_url.replace("postgresql+asyncpg://", "postgresql://", 1)


@asynccontextmanager
async def open_postgres_pool(
    database_url: str, *, max_size: int = 10, label: str = "persistence"
) -> AsyncIterator[Any]:
    """Open a psycopg async connection pool compatible with LangGraph savers/stores."""
    from psycopg.rows import dict_row
    from psycopg_pool import AsyncConnectionPool

    # autocommit for setup(), dict rows, and no prepared statements behind poolers.
    pool = AsyncConnectionPool(
        conninfo=_psycopg_conninfo(database_url),
        max_size=max_size,
        kwargs={"autocommit": True, "prepare_threshold": 0, "row_factory": dict_row},
        open=False,
    )
    try:
        await pool.open(wait=True, timeout=10)
    except Exception as exc:
        await pool.close()
        raise RuntimeError(f"Failed to initialize Postgres {label}: {exc}") from exc

    try:
        yield pool
    finally:
        await pool.close()


@asynccontextmanager
async def open_checkpointer(settings: AgentSettings) -> AsyncIterator[BaseCheckpointSaver]:
    """Open the checkpointer for the app lifetime and release it on exit.

    Development (or no ``DATABASE_URL``) uses ``InMemorySaver``.  Every other
    environment requires Postgres: a failure raises instead of silently falling
    back to memory, which would lose paused confirmations on restart.
    """
    if settings.environment == "development" or not settings.database_url:
        logger.info("Using InMemorySaver checkpointer for development/testing.")
        yield InMemorySaver()
        return

    from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver

    async with open_postgres_pool(
        settings.database_url, max_size=10, label="checkpointer"
    ) as pool:
        saver = AsyncPostgresSaver(pool)
        try:
            await saver.setup()  # idempotent: creates/migrates LangGraph checkpoint tables
        except Exception as exc:
            raise RuntimeError(f"Failed to initialize Postgres checkpointer: {exc}") from exc
        logger.info("Using AsyncPostgresSaver checkpointer.")
        yield saver
