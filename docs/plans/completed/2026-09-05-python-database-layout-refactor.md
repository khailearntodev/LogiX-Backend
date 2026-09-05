# Execution Plan: Python Database Layout Refactor

Date: 2026-09-05

## Status

Completed

## Outcome

Agent, Forecast, and Route Optimizer database code uses unique `src` packages
and feature-first model modules, so a model is discoverable by business area
without changing any PostgreSQL schema or implementing non-database runtime code.

## Context

- `docs/WORKFLOW.md`
- `docs/architecture/README.md`
- `docs/architecture/ai-services-technical-design.md`
- `docs/architecture/database-design.md`
- `docs/decisions/0001-python-persistence-sqlalchemy-alembic.md`
- `docs/decisions/0002-python-service-source-layout.md`
- `docs/plans/completed/2026-09-05-python-service-databases.md`

## Scope

In scope:

- Move importable code under `src/logix_agent`, `src/logix_forecast`, and
  `src/logix_route_optimizer`.
- Split SQLAlchemy mappings by business feature.
- Keep database base/session code under each service-local `db` package.
- Add an explicit model registry used by Alembic and metadata tests.
- Update Python packaging, imports, database README files, tests, and the target
  source-layout section of the AI architecture document.

Out of scope:

- FastAPI application/router scaffolding.
- LangChain, LangGraph, LiteLLM, agent/tool registry, workers, or engines.
- Changes to tables, columns, constraints, indexes, schemas, or migration history.
- Shared ORM models or a cross-service Python database package.

## Approach

1. Record the accepted unique-package and feature-first database layout.
2. Move base/session infrastructure into each service's unique package.
3. Split model declarations into feature modules and load them through one
   side-effect-only `db.model_registry` module.
4. Update Alembic and tests to import the unique package.
5. Reinstall all three distributions together and prove imports do not collide.
6. Require identical Alembic metadata, reversible migrations, and zero drift.

## Risks And Recovery

- Missing model import could make Alembic propose dropping a table; metadata table
  inventory tests and `alembic check` must remain clean.
- Split relationship declarations may fail only when all mappers configure;
  tests configure every mapper with warnings treated as errors.
- Package discovery may accidentally omit modules; build/install all three
  distributions into the same environment and import each by its unique name.
- Recovery is to restore the previous `app/persistence` layout; the database and
  existing migration revision remain untouched.

## Progress

- [x] Confirm database-only refactor scope with the repository owner.
- [x] Inspect current imports and bind refactor evidence to this worktree.
- [x] Record the source-layout decision.
- [x] Refactor Agent database package and models.
- [x] Refactor Forecast database package and models.
- [x] Refactor Route Optimizer database package and models.
- [x] Update Alembic, packaging, documentation, and tests.
- [x] Validate package isolation and unchanged database metadata.
- [x] Record results and move this plan to `docs/plans/completed/`.

## Decisions

- 2026-09-05: Use unique `src/logix_*` import packages to prevent three installed
  services from competing for the generic top-level package name `app`.
- 2026-09-05: Organize ORM mappings by feature and use `db.model_registry` only as
  an Alembic/metadata import aggregator.
- 2026-09-05: Do not create empty future architecture folders in this change.

## Validation

- Focused proof: all metadata/model tests pass with warnings treated as errors.
- Packaging proof: all three editable distributions install together and their
  unique packages import in one Python process.
- Integration proof: Alembic downgrade/upgrade remains reversible on PostgreSQL.
- Drift proof: every service reports no new Alembic upgrade operations.
- Repository proof: Python compile, package build where available, and
  `git diff --check`.

## Result

- The three distributions now expose unique `src` packages and can be installed
  and imported together: `logix_agent`, `logix_forecast`, and
  `logix_route_optimizer`.
- ORM declarations are grouped into business-feature modules. Each service's
  `db.model_registry` exposes exactly the expected 9, 7, and 5 mapped classes.
- The original Alembic revision `20260905_0001` remains unchanged for every
  service; the refactor created no new migration.
- All 15 metadata/mapper tests pass with warnings treated as errors.
- On PostgreSQL 17, all three services passed
  `upgrade head -> alembic check -> downgrade base -> upgrade head -> alembic check`.
  Both drift checks for every service reported no new upgrade operations.
- All source packages compile, editable wheel installation succeeds for all
  three distributions in the same environment, and `git diff --check` reports
  no whitespace errors.
- No API, agent, graph, tool runtime, forecast engine, route engine, or other
  non-database implementation was added.
