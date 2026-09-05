# 0002 Python Service Source Layout

Date: 2026-09-05

## Status

Accepted

## Context

The three Python services used the same top-level import package name, `app`, and
placed all ORM mappings for a service in one `persistence/models.py` file. That
layout was sufficient to establish persistence but made monorepo imports
ambiguous and made models harder to find as each service grew.

The repository owner selected a scalable modular architecture and requested that
the current change refactor only database code, without scaffolding future API,
agent, orchestration, tool, worker, or engine implementations.

## Decision

Each Python service uses a `src` layout and a unique import package:

- `logix_agent`;
- `logix_forecast`;
- `logix_route_optimizer`.

Within a service, database infrastructure lives in `db`, while ORM declarations
live in feature-owned `modules/<feature>/models.py` modules. A service-local
`db.model_registry` imports every mapped class so Alembic receives the complete
`Base.metadata`; it does not define models or business behavior.

Alembic configuration and revision history remain at the service root. Services
do not share ORM models, declarative bases, migrations, or repositories.

This decision establishes package and dependency boundaries. It does not require
empty folders for features that have not been implemented.

## Alternatives Considered

1. Keep `app/persistence/models.py`. Rejected because the package name collides
   across installed monorepo services and the model file grows without a clear
   discovery boundary.
2. Use a global `models/` directory grouped only by technical type. Rejected
   because a feature change would remain scattered across top-level layers.
3. Create the full future Hexagonal structure now. Rejected for this change
   because empty placeholders provide no behavior and the owner limited the
   implementation to database code.
4. Share a Python ORM package across services. Rejected because it would weaken
   service-owned persistence and independent migration histories.

## Consequences

Positive:

- All three distributions can be installed and imported together safely.
- Models are located by business feature rather than inside one large file.
- Alembic retains one explicit, testable metadata-loading entry point.
- Future API/application/adapters can be added beside real features without
  reorganizing the database package again.

Tradeoffs:

- Model relationships rely on all feature modules being loaded by the registry.
- A model move requires updating the registry and public module exports.
- Some infrastructure patterns remain intentionally duplicated across services.

## Follow-Up

- Add non-database modules only when their implementation begins.
- Encode import-direction checks after the future application/adapter boundaries
  are implemented and accepted precisely enough to validate mechanically.
