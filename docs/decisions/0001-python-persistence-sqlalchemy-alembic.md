# 0001 Python Persistence With SQLAlchemy And Alembic

Date: 2026-09-05

## Status

Accepted

## Context

Agent, Forecast, and Route Optimizer are Python/FastAPI services that require
service-owned PostgreSQL persistence. The repository needed one runtime ORM and
one migration owner for these services. Alembic is a migration tool rather than
an ORM, so it requires a compatible schema metadata owner.

## Decision

Each Python service uses SQLAlchemy 2 async for ORM/query access and owns an
independent Alembic environment and revision history. Each service maps only its
own PostgreSQL schema and receives its connection URL through `DATABASE_URL`.

Route Optimizer persists job, result, and benchmark metadata for MVP
reproducibility. This persistence does not make it authoritative for route
approval or dispatch; those decisions remain in Transport Service.

LangGraph checkpoint tables remain owned by the selected checkpointer adapter and
are not mixed into the Agent Service business models or Alembic migration.

## Alternatives Considered

1. Use Alembic without SQLAlchemy ORM metadata. Rejected because the user asked
   for ORM-backed Python persistence and this would duplicate schema definitions.
2. Reuse Prisma from the NestJS services. Rejected because Prisma is not the
   selected Python runtime access layer.
3. Use one centralized migration project. Rejected because it weakens
   service-owned schema and deployment boundaries.
4. Keep Route Optimizer stateless. Rejected for this MVP because persisted input
   hashes, solver versions, metrics, and job state are required for reproducible
   evaluation and completion events.

## Consequences

Positive:

- Runtime mappings and Alembic autogeneration share one metadata source.
- Every Python service can migrate and deploy independently.
- Async PostgreSQL access fits FastAPI workers and APIs.
- Forecast and route benchmark evidence remains reproducible.

Tradeoffs:

- Similar infrastructure models such as inbox/outbox are repeated per service.
- Each service needs its own migration validation and connection configuration.
- PostgreSQL-specific JSONB, partial indexes, and UUID types reduce portability.

## Follow-Up

- Add clean PostgreSQL migration and schema-drift checks to CI.
- Select and integrate the LangGraph PostgreSQL checkpointer separately.
- Confirm retention, RLS, and production database-role policy in later ADRs.
