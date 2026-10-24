"""Checkpointer factory for planner graph state persistence."""

from __future__ import annotations

import logging

from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.checkpoint.memory import InMemorySaver

from logix_agent.config import AgentSettings

logger = logging.getLogger(__name__)


def create_checkpointer(settings: AgentSettings) -> BaseCheckpointSaver:
    """Create a checkpointer based on configuration and environment."""
    if settings.environment == "development" or not settings.database_url:
        logger.info("Using InMemorySaver checkpointer for development/testing.")
        return InMemorySaver()

    try:
        from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver

        # Convert asyncpg or standard url to psycopg connection string if needed
        conn_str = settings.database_url
        if conn_str.startswith("postgresql+asyncpg://"):
            conn_str = conn_str.replace("postgresql+asyncpg://", "postgresql://", 1)

        # AsyncPostgresSaver will be initialized during startup
        # For now, return AsyncPostgresSaver with connection string
        logger.info("Configuring AsyncPostgresSaver with database connection.")
        # Note: caller or lifecycle creates tables via saver.setup()
        return AsyncPostgresSaver.from_conn_string(conn_str)
    except Exception as exc:
        if settings.environment != "development":
            raise RuntimeError(f"Failed to initialize Postgres checkpointer: {exc}") from exc
        logger.warning(
            "Failed to initialize Postgres checkpointer (%s), falling back to InMemorySaver for development.",
            exc,
        )
        return InMemorySaver()
