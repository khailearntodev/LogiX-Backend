# LogiX Architecture

## Purpose

This directory is the architecture entry point for **LogiX-Backend**.

It documents the accepted target architecture, service boundaries, data ownership,
event-driven integration, and runtime topology that implement the approved
business requirements.

For architecture-related work, agents should read this file first and then only
the documents relevant to the requested change.

## Authority and status

- **Business authority:** the approved LogiX BRD.
- **Architecture documentation authority:** the accepted documents in this directory.
- **Decision authority:** `docs/decisions/` when architecture decisions are recorded as ADRs.
- **Implementation evidence:** source code, tests, contracts, runtime configuration,
  and validation reports.
- **Status:** this architecture set is the proposed baseline derived from the BRD
  and the currently agreed repository structure. Any architecture choice not
  explicitly required by the BRD must be confirmed by an ADR before it is treated
  as accepted architectural policy.

Do not invent business requirements from implementation convenience. When the
architecture is ambiguous, inspect the BRD and relevant decision records first.
If material choices remain open, stop before changing architecture.

## Architecture map

| Document | Purpose | Read when |
|---|---|---|
| `system-overview.md` | Overall system context, layers, major components, communication styles, and core principles. | Any architecture change or cross-service task. |
| `service-boundaries.md` | Service responsibilities, ownership boundaries, allowed dependencies, and MVP scope. | Adding/changing a service, module, endpoint, or cross-service workflow. |
| `data-ownership.md` | Domain ownership, persistence boundaries, consistency rules, and cross-service data access constraints. | Changing schemas, repositories, transactions, or business invariants. |
| `event-architecture.md` | Event contracts, producers/consumers, envelope, idempotency, ordering, retry, and delivery rules. | Changing Kafka, events, consumers, producers, or asynchronous workflows. |
| `runtime-architecture.md` | Runtime deployment topology, infrastructure dependencies, observability, resilience, and environment expectations. | Docker/Kubernetes, infrastructure, scaling, availability, or operations work. |

## Target architecture at a glance

```text
Clients / UI
    |
    v
API Gateway
    |
    +------------------------------+
    |                              |
    v                              v
Core Business Services        Planner Agent
    |                              |
    |                              +--> Business Tools / APIs
    |                              +--> Forecast Tool
    |                              +--> Route Optimizer
    |                              +--> LLM Provider Adapter
    |
    +------ synchronous APIs ------+
    |
    +------ domain events ------> Kafka ------> interested consumers

Persistence:
- Service-owned PostgreSQL data
- Redis for explicitly justified cache/state use

AI rule:
- LLM interprets and orchestrates; specialized forecast/route components calculate.
- Sensitive mutations require preview + explicit confirmation.
- Core business flows remain usable when AI/model services are unavailable.
```

## Architecture principles

1. **Core logistics is AI-independent.** Order, inventory, fulfillment, transport,
   audit, and other core workflows must continue through normal UI/API paths when
   AI/model services are unavailable.

2. **Business ownership is explicit.** Each business capability has one owning
   service. Other services consume stable contracts rather than reaching into
   another service's database.

3. **Events are integration contracts.** Domain events use versioned schemas,
   tenant context, correlation/causation metadata, aggregate versioning, and
   consumer idempotency.

4. **Tenant isolation is a system-wide invariant.** Business records and operations
   carry tenant context and cross-tenant access is denied by default.

5. **Authorization is server-side.** RBAC applies consistently to UI/API/tool paths;
   an Agent never gains broader authority than the requesting user.

6. **Sensitive actions require human confirmation.** Confirm/cancel order,
   approve route, and dispatch require preview plus explicit confirmation in the
   same tenant/user context.

7. **Specialized quantitative engines remain deterministic and testable.**
   Forecasting and route optimization are performed by dedicated model/solver
   services or tools, not improvised by an LLM.

8. **Validation is part of architecture.** Changes to reliability, security,
   data ownership, event contracts, and other invariants require executable or
   observable proof.

## Scope guardrails

The MVP is a B2B distribution platform for tenants with one or more warehouses
and an internal delivery fleet. Each order is fulfilled from exactly one
warehouse in the MVP.

The MVP intentionally excludes 3PL marketplace operations, deep WMS, live
GPS/ETA/geofencing, split orders/multi-warehouse fulfillment, returns/reverse
logistics, payment, and other out-of-scope capabilities listed in the BRD.

The stretch e-commerce path must normalize external orders into the internal
`SalesOrder` flow without changing the core fulfillment flow.

## Agent reading rules

For a task affecting one business capability:

1. Read this file.
2. Read the relevant service-boundary and data-ownership documents.
3. Read event architecture if the change touches asynchronous communication.
4. Read runtime architecture if the change affects deployment, observability,
   resilience, or scale.
5. Read relevant decision records before changing a decided policy.
6. Use code and tests as implementation evidence. Do not treat undocumented
   inference as architecture authority.
