# Agent Instructions

<!-- HARNESS:BEGIN -->
## Harness

Start with the requested outcome and use the repository as the system of record.
Read `docs/WORKFLOW.md` and only relevant product, design, plan, code, and
validation material.

- Answers, explanations, reviews, diagnoses, plans, and status reports are
  read-only. Inspect only what is needed; change nothing.
- For a bounded change, inspect affected behavior and proof, implement, and
  validate. No control-plane operation is required.
- Use one `docs/plans/active/` file when work spans sessions, coordinates
  contributors, has dependencies, or needs recovery. Move it to
  `docs/plans/completed/` only after validation.
- Before editing, identify repository authority for each new externally
  observable policy. If materially different choices remain open, stop before
  edits; configurable defaults are not authority.
- For architecture, reliability, security, or quality invariant work, read
  `docs/patterns/encoding-invariants.md` and enforce only accepted rules.
- Report reusable agent friction. Change guidance, tools, runbooks, or validation
  for that purpose only when explicitly asked to use `$improve-harness`.
- Also pause when product intent remains ambiguous, recovery is difficult,
  validation is weakened, or authority is insufficient.
- Claim completion only with executable or observable evidence. Report outcome,
  changes, validation, and unresolved risks.

Harness has no task database or orchestration lifecycle. Use repository plans
and behavior-level proof; do not create parallel control-plane state.
<!-- HARNESS:END -->

## Backend Scope And Boundaries

This repository owns the LogiX backend platform: the API boundary, core
business services, AI/quantitative services, shared contracts, events, and
runtime infrastructure. The approved business and architecture authorities
are the BRD at `docs/plan_ghi_ro_so_task_backlog/brd.md` and the documents
indexed by `docs/architecture/README.md`.

### Service Ownership

- `identity-service`: tenant, user, role, session, and tenant context.
- `master-data-service`: customer, address, product, warehouse, vehicle, and
  driver master data.
- `order-service`: SalesOrder, OrderLine, and order state transitions.
- `inventory-service`: balances, reservations, stock movements, and stock
  invariants.
- `fulfillment-service`: Shipment lifecycle and readiness.
- `transport-service`: DeliveryTrip, TripStop, assignment, route approval, and
  dispatch.
- `notification-service`: notification delivery/read state, not source business
  truth.
- `audit-service`: immutable audit records and audit queries.
- `agent-service`: conversations, tool orchestration, permissions, and
  confirmation state, never direct business persistence.
- `forecast-service`: forecast runs/results and baseline metadata.
- `route-optimizer-service`: optimization proposals and reproducibility
  metadata; Dispatcher remains the approval authority.

### Boundary Rules

- A service owns its business rules and persistence; other services do not
  query its database directly.
- Cross-service reads use APIs/contracts; asynchronous reactions use versioned
  events with tenant, correlation, causation, and aggregate-version context.
- Every tenant-owned operation is tenant-scoped and server-side authorized.
- Core order, inventory, fulfillment, transport, audit, and identity flows must
  remain usable when AI/model services are unavailable.
- LLMs interpret and orchestrate only. Forecast and route results come from
  specialized components; sensitive mutations require preview and explicit
  confirmation.
- Preserve MVP guardrails: one warehouse per order, no split orders, one order
  to at most one shipment, internal fleet, and no deep WMS, 3PL, payment,
  reverse-logistics, live GPS, or geofencing scope unless an accepted decision
  changes the BRD boundary.

### Validation

Use the smallest affected service check, then normally run the repository proof:

```text
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

For event, tenant-isolation, idempotency, reliability, or AI-boundary changes,
require executable contract/integration evidence and report any unverified
runtime or infrastructure claim.

### Repository Boundary

The sibling `LogiX-Frontend` repository owns presentation and client interaction
only. Coordinate cross-repository changes through accepted API/event contracts;
do not move business rules, persistence ownership, or authorization authority
into the frontend.

### Architecture

For architecture-related work, use `docs/architecture/README.md` as the
architecture documentation entry point.

Read only the architecture documents relevant to the requested change.

Do not invent or infer undocumented architecture decisions as accepted
architecture.

For architecture, reliability, security, or quality invariant work, also read
`docs/patterns/encoding-invariants.md`.