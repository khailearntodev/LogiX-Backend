# Agent service database

This service owns the `agent` PostgreSQL schema. SQLAlchemy models are grouped by
feature under `src/logix_agent/modules/*/models.py`. `db/model_registry.py` is the
single import registry used by Alembic, and Alembic is the only supported
schema-change path.

Set an async SQLAlchemy URL and run migrations from this directory:

```powershell
$env:DATABASE_URL = "postgresql+asyncpg://postgres:postgres@localhost:5433/logix_agent"
alembic upgrade head
alembic check
```

LangGraph checkpoint tables are intentionally excluded and must be managed by
the selected checkpoint adapter.
