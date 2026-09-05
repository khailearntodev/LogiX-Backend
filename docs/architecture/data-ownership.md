# Data Ownership and Consistency

## Status

Proposed target baseline derived from the BRD domain model and reliability requirements.

## 1. Persistence ownership

Each business service owns its own persistence boundary. A shared PostgreSQL cluster is acceptable for the project, but services must not share a single business schema as a shortcut around service boundaries.

Recommended logical ownership:

| Service | Primary data |
|---|---|
| Identity | Tenant, User, Role, identity/session metadata |
| Master Data | Customer, CustomerAddress, Product, Warehouse, Vehicle, Driver |
| Order | SalesOrder, OrderLine, order state/history |
| Inventory | InventoryBalance, InventoryReservation, StockMovement |
| Fulfillment | Shipment, shipment state/history |
| Transport | DeliveryTrip, TripStop, RoutePlan, trip/route state |
| Notification | Notification and delivery/read state |
| Audit | AuditLog |
| Agent | Conversation, AgentExecution, tool execution metadata |
| Forecast | ForecastRun, ForecastResult |
| Route Optimizer | Optimization request/result metadata where persistence is required |

## 2. Domain ownership rules

### Tenant

Identity is the authority for tenant identity and tenant lifecycle. Every business record references one tenant context.

### Customer / Address / Product / Warehouse / Vehicle / Driver

Master Data is authoritative. Business services store only identifiers and bounded snapshots where justified by read-model or audit needs.

### SalesOrder

Order Service is authoritative for order status and order commands.

### Inventory

Inventory Service is authoritative for `on_hand`, `reserved`, `available`, reservation state, and stock movements.

### Shipment

Fulfillment Service is authoritative for shipment state.

### DeliveryTrip / TripStop / RoutePlan

Transport Service is authoritative for trip state, stop assignment, route approval/override, and dispatch state.

### Forecast

Forecast Service is authoritative for forecast execution metadata and forecast result versions.

### AgentExecution

Agent Service is authoritative for agent execution lifecycle. Business outcome remains authoritative in the invoked business service.

### AuditLog

Audit Service is authoritative for immutable audit records.

## 3. Transaction boundaries

A business invariant that can be enforced inside one service should be enforced transactionally inside that service.

Cross-service business flows must not assume a distributed ACID transaction across service databases. Use explicit commands/events, idempotency, retry/fallback handling, and observable state transitions.

Examples:

```text
Order confirmation
  Order transaction creates/changes order-side state
  -> Inventory reservation command/event interaction
  -> final state represented by explicit events/status
```

```text
Trip dispatch
  Transport authorizes dispatch
  -> dispatch event with version/idempotency key
  -> Inventory performs exactly-once business effect under idempotent handling
```

## 4. Inventory consistency

The BRD invariant is:

`available_quantity = on_hand_quantity - reserved_quantity`

Required rules:

- confirming an order increases reserved, not on-hand;
- dispatch/stock issue decreases both on-hand and reserved by the reserved amount;
- cancel before dispatch releases reserved and creates no stock issue;
- every on-hand change creates StockMovement;
- available cannot become negative;
- duplicate events/commands must not create duplicate reservation or stock issue.

## 5. Versioning and concurrency

Important commands/events should carry aggregate or entity version information so that stale or out-of-order updates cannot move a state backward.

The BRD requires optimistic versioning or equivalent control for important commands and explicitly requires an event envelope containing aggregate type, aggregate id, and aggregate version.

## 6. Read models and projections

Read-optimized projections are allowed when they improve dashboard/query performance, but the owning service remains the authority for the business state.

A projection must be:

- rebuildable from source events or authoritative data;
- tenant-scoped;
- treated as derived state, not business authority;
- updated idempotently.

## 7. Soft delete / disable behavior

Disable and soft delete have different semantics:

- disable/lock is a reversible business state and records when and why an administrator made the entity unavailable;
- soft delete sets `deleted_at`, excludes the row from normal business queries, and retains it until an approved retention process may hard-delete it;
- mutable tenant-owned business tables use nullable `deleted_at` as the common soft-delete marker;
- normal repositories filter `tenant_id` and `deleted_at IS NULL`; recovery or administrative access to deleted rows requires an explicit authorized path;
- soft-deleting a row increments its optimistic version, updates `updated_at`, and produces the required audit record.

Master data that is referenced by business records should be disabled/locked rather than hard-deleted. Soft deletion does not permit historical references to be broken or business identifiers to be reused automatically.

This preserves historical references and avoids breaking existing orders, shipments, trips, and audit records.

Append-only ledgers and histories are exceptions to the mutable soft-delete shape. `stock_movements`, order/shipment status histories, completed delivery-attempt records, and `audit_logs` are not updated, deleted, or soft-deleted through business APIs. Any archive or purge is performed only by a separately authorized retention process.

## 8. AI data boundary

The Agent does not persist or mutate business state on behalf of other services. It may persist execution metadata and sanitized tool I/O necessary for audit/metrics, but the actual business mutation is executed by the owning service under normal validation and authorization.

Sensitive data and tokens must not be logged raw.
