# Execution Plan: Python Service Databases

Date: 2026-09-05

## Status

Completed

## Outcome

Agent, Forecast, and Route Optimizer services each own a PostgreSQL schema,
SQLAlchemy 2 async models, and an independently runnable Alembic migration that
creates the approved MVP persistence structures from a clean database.

## Context

- `docs/plan_ghi_ro_so_task_backlog/brd.md`
- `docs/architecture/database-design.md`
- `docs/architecture/data-ownership.md`
- `docs/architecture/event-architecture.md`
- `docs/architecture/ai-services-technical-design.md`
- `docs/decisions/0001-python-persistence-sqlalchemy-alembic.md`

## Scope

In scope:

- Per-service Python packaging and database configuration.
- SQLAlchemy 2 async sessions and service-owned declarative models.
- Agent schema for conversations, executions, model/tool calls, confirmations,
  provider configuration, inbox, and outbox.
- Forecast schema for demand observations, runs, series, results, metrics,
  inbox, and outbox.
- Route Optimizer schema for optimization runs, stops, metrics, and outbox.
- Initial Alembic migration and model/migration structural tests per service.
- PostgreSQL clean-schema migration verification when the local runtime permits.

Out of scope:

- FastAPI endpoints, workers, Kafka publishers/consumers, and domain services.
- LangGraph checkpoint tables, which remain owned by the selected checkpointer.
- RLS, partitioning, retention purge jobs, and production database roles.
- Core NestJS/Prisma service schemas.

## Approach

1. Establish the accepted Python persistence decision and per-service layout.
2. Implement shared patterns locally in each service to preserve schema ownership.
3. Encode tenant-safe internal foreign keys, checks, unique constraints, indexes,
   soft-delete columns, optimistic versions, and event idempotency.
4. Generate/review explicit initial Alembic migrations.
5. Run import, metadata, offline migration, and clean PostgreSQL migration proof.
6. Update the architecture details only where implementation resolves an existing
   schema ambiguity, then record the verified result.

## Risks And Recovery

- Model and migration drift: compare Alembic target metadata with a clean migrated
  database and require an empty autogenerate diff.
- Cross-tenant internal references: use composite `(tenant_id, id)` unique keys and
  composite foreign keys inside each service schema.
- JSON metadata may become unstructured: keep JSONB only on fields explicitly
  authorized by the database/AI design.
- A failed migration can be recovered by dropping only the isolated test database
  or schema created for validation and rerunning from revision zero.

## Progress

- [x] Confirm SQLAlchemy + Alembic scope for Python services.
- [x] Record the persistence decision.
- [x] Scaffold Agent Service persistence and migration.
- [x] Scaffold Forecast Service persistence and migration.
- [x] Scaffold Route Optimizer Service persistence and migration.
- [x] Add structural and migration tests.
- [x] Validate all migrations and model/schema parity.
- [x] Record results and move this plan to `docs/plans/completed/`.

## Decisions

- 2026-09-05: Use SQLAlchemy 2 async for runtime ORM access and Alembic for
  migrations in each Python service, as explicitly selected by the repository owner.
- 2026-09-05: Persist Route Optimizer jobs/results for reproducibility and benchmark
  evidence; Transport remains authoritative for route approval and dispatch.
- 2026-09-05: Keep initial migrations explicit and service-local; do not create a
  cross-service ORM/model package.

## Validation

- Focused proof: pytest model metadata and constraint/index assertions per service.
- Integration proof: upgrade each service from Alembic base to head on clean PostgreSQL.
- Drift proof: Alembic autogenerate reports no schema changes after upgrade.
- Repository-required checks: Python compile/import tests and `git diff --check`.

## Result

- Added independently packaged SQLAlchemy 2 async persistence and Alembic
  environments for Agent, Forecast, and Route Optimizer services.
- Added initial migrations for 9 Agent tables, 7 Forecast tables, and 5 Route
  Optimizer tables. Every table has the agreed base lifecycle columns, including
  optimistic `version` and soft-delete `deleted_at`.
- Added idempotent PostgreSQL container initialization for the three service
  databases; each Alembic migration creates its service-owned schema.
- Kept `model_metadata` scoped to AI result records rather than making untyped
  JSONB part of every table's base columns.
- Verified all 15 focused metadata tests with warnings treated as errors.
- Verified upgrade, downgrade, and re-upgrade on three clean PostgreSQL 17
  databases; all databases report revision `20260905_0001 (head)`.
- Verified `alembic check` reports no model/migration drift and offline migration
  SQL renders successfully for every service.
- Verified the live schemas contain 9/7/5 tables respectively and every table in
  each schema contains both `version` and `deleted_at`.
