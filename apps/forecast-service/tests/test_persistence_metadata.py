from sqlalchemy import ForeignKeyConstraint
from sqlalchemy.orm import configure_mappers

from logix_forecast.db.base import Base
from logix_forecast.db import model_registry  # noqa: F401


BASE_COLUMNS = {"id", "tenant_id", "created_at", "updated_at", "version", "deleted_at"}


def test_forecast_schema_contains_the_owned_tables() -> None:
    assert set(Base.metadata.tables) == {
        "forecast.demand_observations",
        "forecast.forecast_metrics",
        "forecast.forecast_results",
        "forecast.forecast_runs",
        "forecast.forecast_series",
        "forecast.inbox_events",
        "forecast.outbox_events",
    }


def test_every_forecast_table_has_the_base_columns() -> None:
    for table in Base.metadata.tables.values():
        assert BASE_COLUMNS <= set(table.columns.keys()), table.fullname


def test_model_metadata_is_scoped_to_forecast_results() -> None:
    tables_with_model_metadata = {
        table.fullname
        for table in Base.metadata.tables.values()
        if "model_metadata" in table.columns
    }
    assert tables_with_model_metadata == {"forecast.forecast_results"}


def test_forecast_children_use_tenant_safe_foreign_keys() -> None:
    for table_name, foreign_key_columns in {
        "forecast.forecast_series": {"tenant_id", "forecast_run_id"},
        "forecast.forecast_results": {"tenant_id", "forecast_series_id"},
        "forecast.forecast_metrics": {"tenant_id", "forecast_series_id"},
    }.items():
        table = Base.metadata.tables[table_name]
        assert any(
            isinstance(constraint, ForeignKeyConstraint)
            and {column.name for column in constraint.columns} == foreign_key_columns
            for constraint in table.constraints
        )


def test_all_mappers_configure_without_warnings() -> None:
    configure_mappers()
    for mapper in Base.registry.mappers:
        assert mapper.version_id_col is mapper.local_table.c.version
