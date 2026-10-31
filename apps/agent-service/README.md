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

## Delivery route tools

Inject `TRANSPORT_SERVICE_URL` (Transport `/api/v1` host) through process
environment. Agent configuration does not load `.env` files.
`propose_trip_route` requires a real `trip_id` and `expected_trip_version` and
calls Transport's trip-scoped optimizer endpoint; it does not call `/sample`
or construct plan versions. `get_route_plan_comparison` requires the actual
trip+RoutePlan identities and reads persisted nullable metrics/baselines.
An optimization run ID is distinct from both RoutePlan and DeliveryTrip IDs.

`approve_trip_route` requires the current trip version, exact plan/version/hash,
and the existing sensitive-action confirmation. Its preview calls Transport's
real route-approval-preview endpoint. The opaque backend token is retained only
in the existing approval execution binding, excluded from the model-visible
summary and public confirmation interrupt, and reused unchanged with the stable confirmation approval ID as
`requestId`. A stale/expired preview must fail and request a new explicit
preview; confirmation must never silently substitute a fresh token.
The tool cannot dispatch or execute Driver delivery operations.

The shared client also accepts `ROUTE_OPTIMIZER_SERVICE_URL` and
`FORECAST_SERVICE_URL` from process environment. These service mappings do not
change route-tool ownership: proposals and comparisons still go through
Transport and use persisted measurements, not fabricated baseline durations.
