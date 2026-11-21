"""Thread ownership registry (InMemory for dev/tests, PostgreSQL for staging/prod)."""

from __future__ import annotations

from logix_agent.modules.conversations.service import (
    InMemoryThreadStore,
    InvalidThreadIdError,
    SqlAlchemyThreadStore,
    StoredMessage,
    ThreadNotFoundError,
    ThreadStore,
    ThreadSummary,
)

ThreadRegistry = InMemoryThreadStore

__all__ = [
    "InMemoryThreadStore",
    "InvalidThreadIdError",
    "SqlAlchemyThreadStore",
    "StoredMessage",
    "ThreadNotFoundError",
    "ThreadRegistry",
    "ThreadStore",
    "ThreadSummary",
]
