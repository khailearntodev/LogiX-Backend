"""Checkpointer factory for planner graph state persistence."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.checkpoint.memory import InMemorySaver

from logix_agent.config import AgentSettings

logger = logging.getLogger(__name__)


def _psycopg_conninfo(database_url: str) -> str:
    """LangGraph's Postgres saver uses psycopg, not the asyncpg driver of the ORM URL."""
    return database_url.replace("postgresql+asyncpg://", "postgresql://", 1)


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
    from psycopg.rows import dict_row
    from psycopg_pool import AsyncConnectionPool

    # Settings required by AsyncPostgresSaver: autocommit for setup(), dict rows,
    # and no prepared statements (they break behind connection poolers).
    pool = AsyncConnectionPool(
        conninfo=_psycopg_conninfo(settings.database_url),
        max_size=10,
        kwargs={"autocommit": True, "prepare_threshold": 0, "row_factory": dict_row},
        open=False,
    )
    try:
        await pool.open(wait=True, timeout=10)
        saver = AsyncPostgresSaver(pool)
        await saver.setup()  # idempotent: creates/migrates LangGraph checkpoint tables
    except Exception as exc:
        await pool.close()
        raise RuntimeError(f"Failed to initialize Postgres checkpointer: {exc}") from exc

    logger.info("Using AsyncPostgresSaver checkpointer.")
    try:
        yield saver
    finally:
        await pool.close()
