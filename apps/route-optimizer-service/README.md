# Route optimizer service database

This service owns the `route_optimizer` PostgreSQL schema. SQLAlchemy models are
grouped by feature under `src/logix_route_optimizer/modules/*/models.py`.
`db/model_registry.py` is the single import registry used by Alembic, and
Alembic is the only supported schema-change path.
The stored input hash, solver/config versions, seed, stops, result, and metrics
make an optimization run reproducible without making this service authoritative
for trip approval or dispatch.

Set an async SQLAlchemy URL and run migrations from this directory:

```powershell
$env:DATABASE_URL = "postgresql+asyncpg://postgres:postgres@localhost:5433/logix_route_optimizer"
alembic upgrade head
alembic check
```
