# Route optimizer service database

This service owns the `route_optimizer` PostgreSQL schema. SQLAlchemy models are
grouped by feature under `src/logix_route_optimizer/modules/*/models.py`.
`db/model_registry.py` is the single import registry used by Alembic, and
Alembic is the only supported schema-change path.
The stored input hash, solver/config versions, seed, stops, result, and metrics
make an optimization run reproducible without making this service authoritative
for trip approval or dispatch.

## Production Transport contract

`POST /api/v1/route-optimizations` accepts only the complete production request:
tenant/trip/version/request/idempotency/hash binding, real depot/vehicle/capacity,
all frozen stop addresses/coordinates/decimal demand and explicit configuration.
The canonical SHA-256 representation uses UTF-8, recursively sorted printable
ASCII keys, compact JSON, safe integers and decimal **strings**. The Python
validator verifies the complete numeric wrapper against the frozen snapshot
and refuses sample/default production fields, duplicate/partial stops,
overcapacity, identity/hash/configuration mismatches.

Both POST and `GET /api/v1/route-optimizations/:runId` require
`x-internal-service-token`: HS256, configured `INTERNAL_SERVICE_JWT_SECRET`,
Transport issuer, optimizer audience, `internal-service` purpose and verified
tenant. The response identifies the distinct persisted optimization run,
actual solver package version, provider/fallback, configuration/time limit,
objective, timestamps, latency, full input and real result/baseline metrics.
The exact request and result are atomically stored in existing run parameters,
with stops/result/metrics/RouteCalculated outbox. Unknown random seed is null,
not fabricated. The production path never reports success when persistence fails.

An exact request retry returns the stored response; changed content under the
same request ID conflicts. Missing runs return 404; unavailable computation or
persistence returns 503, never sample data. `/sample` remains explicitly a
demonstration endpoint, not production evidence. Transport and Agent do not use it.
Transport alone owns plan versions, approval, resource reservations and dispatch.
No `.env` file is loaded by optimizer configuration; inject process environment.

Revision `39a641f6adea` preserves nullable unknown random seed and six-decimal
capacity/demand volume. Existing migrations are unchanged. Run:

```powershell
python -m pytest tests -q
```

The real cross-service Gateway/PostgreSQL/Kafka/optimizer proof is the backend
`scripts\test-trip-integration.mjs --phase3` runner described in Transport's README.

Set an async SQLAlchemy URL and run migrations from this directory:

```powershell
$env:DATABASE_URL = "postgresql+asyncpg://postgres:postgres@localhost:5433/logix_route_optimizer"
alembic upgrade head
alembic check
```
