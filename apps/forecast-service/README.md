# Forecast service database

This service owns the `forecast` PostgreSQL schema. SQLAlchemy models are grouped
by feature under `src/logix_forecast/modules/*/models.py`.
`db/model_registry.py` is the single import registry used by Alembic, and
Alembic is the only supported schema-change path.

Set an async SQLAlchemy URL and run migrations from this directory:

```powershell
$env:DATABASE_URL = "postgresql+asyncpg://postgres:postgres@localhost:5433/logix_forecast"
alembic upgrade head
alembic check
```
