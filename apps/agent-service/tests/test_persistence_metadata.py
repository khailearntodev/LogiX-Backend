from sqlalchemy import ForeignKeyConstraint, UniqueConstraint
from sqlalchemy.orm import configure_mappers

from logix_agent.db.base import Base
from logix_agent.db import model_registry  # noqa: F401


BASE_COLUMNS = {"id", "tenant_id", "created_at", "updated_at", "version", "deleted_at"}


def test_agent_schema_contains_the_owned_tables() -> None:
    assert set(Base.metadata.tables) == {
        "agent.agent_executions",
        "agent.agent_model_calls",
        "agent.confirmation_requests",
        "agent.conversation_messages",
        "agent.conversations",
        "agent.inbox_events",
        "agent.llm_provider_configs",
        "agent.outbox_events",
        "agent.tool_calls",
    }


def test_every_agent_table_has_the_base_columns() -> None:
    for table in Base.metadata.tables.values():
        assert BASE_COLUMNS <= set(table.columns.keys()), table.fullname


def test_confirmation_references_tool_call_with_tenant_boundary() -> None:
    table = Base.metadata.tables["agent.confirmation_requests"]
    foreign_keys = [
        constraint
        for constraint in table.constraints
        if isinstance(constraint, ForeignKeyConstraint)
    ]
    assert any(
        {column.name for column in constraint.columns} == {"tenant_id", "tool_call_id"}
        for constraint in foreign_keys
    )

    tool_calls = Base.metadata.tables["agent.tool_calls"]
    assert any(
        isinstance(constraint, UniqueConstraint)
        and {column.name for column in constraint.columns} == {"tenant_id", "id"}
        for constraint in tool_calls.constraints
    )


def test_model_call_fallback_cannot_cross_tenant_boundary() -> None:
    table = Base.metadata.tables["agent.agent_model_calls"]
    assert any(
        isinstance(constraint, ForeignKeyConstraint)
        and {column.name for column in constraint.columns}
        == {"tenant_id", "fallback_from_call_id"}
        for constraint in table.constraints
    )


def test_all_mappers_configure_without_warnings() -> None:
    configure_mappers()
    for mapper in Base.registry.mappers:
        assert mapper.version_id_col is mapper.local_table.c.version
