from sqlalchemy import ForeignKeyConstraint
from sqlalchemy.orm import configure_mappers

from logix_route_optimizer.db.base import Base
from logix_route_optimizer.db import model_registry  # noqa: F401


BASE_COLUMNS = {"id", "tenant_id", "created_at", "updated_at", "version", "deleted_at"}


def test_route_optimizer_schema_contains_the_owned_tables() -> None:
    assert set(Base.metadata.tables) == {
        "route_optimizer.optimization_metrics",
        "route_optimizer.optimization_results",
        "route_optimizer.optimization_runs",
        "route_optimizer.optimization_stops",
        "route_optimizer.outbox_events",
    }


def test_every_route_optimizer_table_has_the_base_columns() -> None:
    for table in Base.metadata.tables.values():
        assert BASE_COLUMNS <= set(table.columns.keys()), table.fullname


def test_model_metadata_is_scoped_to_optimization_result() -> None:
    tables_with_model_metadata = {
        table.fullname
        for table in Base.metadata.tables.values()
        if "model_metadata" in table.columns
    }
    assert tables_with_model_metadata == {"route_optimizer.optimization_results"}


def test_route_children_use_tenant_safe_foreign_keys() -> None:
    for table_name in (
        "route_optimizer.optimization_stops",
        "route_optimizer.optimization_results",
        "route_optimizer.optimization_metrics",
    ):
        table = Base.metadata.tables[table_name]
        assert any(
            isinstance(constraint, ForeignKeyConstraint)
            and {column.name for column in constraint.columns}
            == {"tenant_id", "optimization_run_id"}
            for constraint in table.constraints
        )


def test_all_mappers_configure_without_warnings() -> None:
    configure_mappers()
    for mapper in Base.registry.mappers:
        assert mapper.version_id_col is mapper.local_table.c.version
