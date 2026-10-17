# Runtime Architecture

## Status

Proposed target runtime baseline for the MVP.

## 1. Runtime topology

```text
                           +-------------------+
                           |   Client / UI     |
                           +---------+---------+
                                     |
                                     v
                           +-------------------+
                           |    API Gateway    |
                           +---------+---------+
                                     |
             +-----------------------+-----------------------+
             |                       |                       |
             v                       v                       v
     Core business APIs       Agent Service          Read/metric paths
             |
             +-------------------+-------------------+
                                 |
                                 v
                              Kafka
                +----------------+----------------+
                |                |                |
                v                v                v
          Business consumers  Notifications   Audit/metrics

      +------------------+     +------------------+
      |  PostgreSQL      |     |      Redis       |
      | service-owned    |     | cache/state only |
      +------------------+     +------------------+

      +------------------+     +------------------+
      | Forecast Service |     | Route Optimizer  |
      +------------------+     +------------------+
                ^                         ^
                |                         |
                +-------- Agent ----------+
```

## 2. Process model

### TypeScript / NestJS group

The core business services and gateway are planned as TypeScript/NestJS applications in the repository's service layout.

### Python / FastAPI group

The quantitative/AI services are planned as Python/FastAPI applications where Python ecosystem support is useful:

- Agent Service;
- Forecast Service;
- Route Optimizer Service.

The exact framework choice should be recorded as an ADR if it becomes a policy that affects repository-wide development conventions.

## 3. Infrastructure

### PostgreSQL

Use PostgreSQL as the primary relational persistence layer. The key architectural boundary is service ownership of data, not whether services physically use one database cluster.

### Redis

Use Redis only where a concrete cache, ephemeral state, rate/coordination mechanism, or similar runtime requirement is established. Do not turn Redis into an undocumented second source of truth.

### Kafka

Kafka is the asynchronous domain-event transport. Topics, partitions, consumer groups, retention, retry/DLQ behavior, and schema/version conventions must be documented as the implementation is finalized.

## 4. API Gateway responsibilities

The gateway is the external request boundary. It may provide:

- routing;
- authentication token forwarding/validation integration;
- request correlation;
- common rate/size controls where required;
- stable external API composition where justified.

It must not become a business-logic dumping ground. Business validation remains in the owning service.

## 5. Configuration and secrets

### User access tokens and permissions

Identity owns effective access resolution (`RolesService.getEffectivePermissions`).
Login, tenant switching, invitation acceptance and refresh use that resolver;
refresh recomputes permissions from current IAM data rather than copying the
refresh token's claims. The access JWT carries `sub`, `email`, `tenantId`,
`role`, `isSuperAdmin` and `permissions`, together with its signed expiry.
The profile/effective-permissions endpoint uses the same IAM rules.

Order, Inventory and Master Data use `@logix/auth`'s `accessTokenUser` to map
verified claims consistently. Passport verifies signature and expiry first.
Refresh JWTs (identified by `jti`) are not API access tokens. Missing permission
claims never grant permissions. Endpoint guards and tenant-scoped business
queries remain required; the mapper alone does not authorize operations.
Identity keeps database-backed user/membership validation for its own APIs.

Business services use a snapshot of permissions until the access token expires
or is replaced. This is not immediate cross-service session/permission revocation.
After deploying this fix, an existing session must refresh or log in again to
replace access tokens issued without permission claims. Do not disable guards
or grant wildcard access to work around an old token.

Deploy/restart Identity, Order, Inventory and Master Data together. Configure the
same `JWT_SECRET` in each service; Inventory and Master Data now fail startup
when it is absent rather than using a fallback secret. A platform administrator
without membership can select an active tenant, but the returned tenant and JWT
must identify that same tenant. An unavailable requested tenant is rejected.

Auth regression verification includes login, refresh, tenant switching,
invitation acceptance, custom read-only roles, permission removal and
refresh-token rejection. The isolated Gateway/PostgreSQL run passed 37 HTTP
checks without business-data writes; test fixtures and owned processes were
removed afterward. Browser UI acceptance and immediate revocation of existing
business-service access tokens are not covered by this verification.

Runtime configuration should be environment-driven. Model/provider selection must be configurable without code recompilation, as required by the BRD.

Secrets such as API keys must come from secret/configuration mechanisms and must never be committed to source control or written to logs/events.

## 6. Observability

Every service must emit structured logs and metrics appropriate to its responsibility. Cross-service operations use correlation metadata.

The MVP must make it possible to observe at least:

- API latency;
- event publish-to-effect latency;
- retry/dead-letter activity;
- service instance/replica behavior;
- Agent tool execution success/failure and latency;
- forecast execution metadata;
- route optimization execution and metrics;
- security/audit-sensitive operations.

Tracing may use a standard distributed-tracing mechanism; the implementation should preserve correlation across HTTP, Kafka, Agent, and quantitative-tool boundaries.

## 7. Resilience

Required runtime behaviors:

- timeouts for remote calls;
- bounded retries with backoff for transient faults;
- idempotent consumers/commands;
- explicit fallback or manual continuation when AI/model services fail;
- health/readiness checks for independently deployed services;
- graceful handling of unavailable downstream dependencies.

A model outage must not prevent ordinary order, inventory, fulfillment, transport, or driver workflows that do not require the AI feature.

## 8. Development and deployment environments

### Local development

Docker Compose is the preferred MVP development environment for infrastructure dependencies and multi-service integration. Keep local setup deterministic and reproducible.

### Kubernetes

Kubernetes is not required for every workload in local development. It is reserved for the scale-out evidence or deployment scenarios that actually need to be demonstrated.

## 9. Performance targets from BRD

The runtime validation plan should measure, at minimum:

- Business API p95 <= 2 seconds for ordinary CRUD/command operations under the published benchmark load.
- Event publish-to-business-effect p95 <= 3 seconds under the published benchmark.
- Route optimization <= 10 seconds for up to 50 stops in the benchmark environment.
- Forecast batch of 100 SKU-warehouse series <= 60 seconds in the benchmark environment, or an explicitly documented measured limit.
- Planner Tool Success Rate >= 90% on the fixed scenario set.

These are acceptance targets from the BRD, not guarantees of the final implementation.

## 10. Operational evidence

A runtime feature is not considered proven by a deployment that merely starts containers. Validation should include observable evidence for the affected property, such as:

- health/readiness checks;
- request/event latency measurements;
- duplicate/out-of-order tests;
- fault injection for AI/solver unavailability;
- scale-out before/after measurements;
- logs/metrics/traces showing correlation.
