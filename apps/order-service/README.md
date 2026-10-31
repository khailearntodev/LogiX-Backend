# order-service

Owns SalesOrder, OrderLine, order shortages and status history. Master Data
references are validated through its API; Order stores immutable snapshots.
Inventory alone owns balances and reservation groups.

Authority: [the implementation plan](../../docs/plan_ghi_ro_so_task_backlog/ke-hoach-trien-khai-quan-ly-don-hang.md),
[the Order specification](../../docs/plan_ghi_ro_so_task_backlog/quan-ly-don-hang-backend-frontend.md)
and [service boundaries](../../docs/architecture/service-boundaries.md).

## Public API

The Gateway forwards `/api/v1/orders`. Access tokens must carry a tenant and
the corresponding `order:sales-order:*` permission; refresh tokens are rejected.

| Method | Path under `/api/v1/orders` | Permission | Purpose |
|---|---|---|---|
| POST | `/` | `create` | Create draft; `Idempotency-Key` required |
| GET | `/` | `read` | Filtered, paginated list |
| GET | `/:id` | `read` | Detail, immutable snapshots and version |
| GET | `/:id/history` | `read` | Status history |
| PATCH | `/:id` | `update` | Edit DRAFT/PENDING_STOCK if no active reservation/cancel intent |
| GET | `/:id/confirm-preview` | `approve` | Current availability and Order version; advisory only |
| POST | `/:id/confirm` | `approve` | `{version}`; reserve all lines or enter PENDING_STOCK |
| POST | `/:id/retry-reservation` | `approve` | `{version}`; retry PENDING_STOCK |
| GET | `/:id/shortages` | `read` | Unresolved shortages with decimal-string required/available |
| POST | `/:id/cancel` | `cancel` | `{version, reason}`; persist intent, release, finalize cancellation |

All commands are tenant-scoped. Version conflicts return 409 rather than
overwriting another command. Preview is not a reservation; confirmation
rechecks inventory. Inventory timeout/network/5xx returns 503, never
INSUFFICIENT or optimistic confirmation.

## Reservation and cancellation

Order holds its row lock while calling Inventory with an internal token and
the stable key `order:{orderId}:v{orderVersion}`. Inventory RESERVED leads to
CONFIRMED; INSUFFICIENT writes shortages and PENDING_STOCK. The first pending
timestamp is retained on retry. Sending line/warehouse changes resets FIFO
position and resolves obsolete shortages.

Edits check Inventory's active group under the Order lock. An orphan reservation
must be reconciled before edits; Inventory unavailability does not permit an
unsafe edit.

Cancellation persists `cancellationRequestedAt`, reason/actor/correlation and
increments version before release. Business status remains unchanged but
editing/confirmation is locked. Successful release commits CANCELED, history
and outbox and increments version again. A background worker retries durable
intents. `cancellationRequestedAt` is exposed for the UI to display recovery.
Repeated public cancel after completion returns 409; recovery workers tolerate
already completed cancellation without another release.

## Dispatch arbitration (phase 5A)

`POST /internal/orders/:orderId/authorize-dispatch` accepts only an internal
token issued by Fulfillment for Order. It is not proxied by Gateway and does
not accept a user access token. Tenant comes from the verified internal claim,
never the body. The body contains UUID `requestId`, `shipmentId`,
`reservationGroupId`, `actorId` and positive safe-integer `orderVersion`.
Success returns 201 with those fields, `orderId`, `grantedAt` and the original
`correlationId`; exact retries return the same decision.

Fulfillment must persist the exact request before calling. Only READY_TO_SHIP
with the expected version and matching reservation can receive a new grant.
Order locks the same row as cancellation and persists the grant plus a version
increment, without changing business status. A pending cancellation blocks a
grant; a grant blocks cancel and cancellation recovery before Inventory release.
Cancellation is allowed in PICKING/READY_TO_SHIP only before a grant.

The decision does not expire and is not proof of completed dispatch/stock issue.
After a grant Fulfillment must recover forward, never infer rejection from a
timeout. Different replay content or a request key used for another order
returns 409. A database CHECK forbids partial decisions and simultaneous
cancellation/dispatch. Deploy the additive migration before the new code.

Fulfillment owns durable dispatch intents and Shipment lifecycle events.
Inventory owns eventual ISSUE, not this grant endpoint.

### Phase 4 whole-set authorization

`POST /internal/orders/authorize-dispatch-batch` is restricted to Fulfillment's
verified internal caller and tenant. The strict shared contract binds request,
trip, actor, approved plan, input hash, trip/dispatch versions and every Shipment,
Order, reservation and stable child dispatchRequestId. The request-level lock
serializes even conflicting retries naming disjoint Orders; sorted Order locks
are the same authority used by direct grants and cancellation.

Order validates every member before writing any grant. The owner transaction
persists either the complete GRANTED decision and all existing per-Order grant
fields, or REJECTED with zero grants. Exact replay returns the original durable
decision before consulting newer Order versions; changed payload or actor is
409. Direct single-Shipment authorization remains supported and cannot bypass
the cancellation/grant lock.

`OrderDispatchBatch` is the immutable full-set decision header: one Order row
cannot represent a many-Order rejection/replay identity. This is not a second
dispatch workflow. Deploy `20261025162402_phase4_durable_dispatch` before owner
code. A grant is irrevocable: cancellation/recovery must never release its stock.

## Events and reconciliation

- Shared relay publishes Order outbox to `KAFKA_ORDER_TOPIC`, preserving
  aggregate order with database row locking. Delivery is at-least-once.
- `StockReceived`/`StockReleased` wake FIFO evaluation by tenant/warehouse.
  Insufficient candidates do not block later orders. Each Order decision and
  its Inbox entry commit together; a warehouse Inbox marks the completed pass.
- `OrderPendingStock` and pending `OrderUpdated` also wake evaluation, covering
  receipts arriving before pending state commits. Repeated insufficient retries
  do not emit another pending event.
- `POST /internal/orders/reconcile-reservation` accepts only Inventory's internal
  token and is not proxied by Gateway. It returns ACKNOWLEDGE for referenced or
  successfully recovered reservations, KEEP during cancellation recovery, and
  explicit RELEASE only when the supplied group is no longer usable by Order.
- Failed Kafka handlers keep their offset and restart for redelivery. Invalid
  permanent events currently require operator repair and can block a partition;
  automatic DLQ handling is not implemented.

Shipment creation, picking, dispatch, stock issue and lifecycle projection are
phase 5, not implemented by this service's phase-4 milestone.

## Configuration and checks

Copy [.env.example](.env.example) into local `.env` and supply all required
values. JWT must match Identity; the internal secret must match Inventory.
Kafka, Inventory and the Order database must be available at startup. Use
[the Kafka runbook](../../infrastructure/docker-compose/README.md) to provision
the shared topics; no broker address is silently defaulted in code.

Run from the backend root:

```powershell
pnpm --filter order-service db:generate
pnpm --filter order-service db:migrate:deploy
pnpm --filter order-service start:dev
```

Validation:

```powershell
pnpm --filter @logix/messaging build
pnpm --filter order-service lint
pnpm --filter order-service test
pnpm --filter order-service exec tsc --noEmit
pnpm --filter order-service build
```

Permanent unit tests are kept as regression coverage. Temporary integration
scripts, QA tenants and dedicated Kafka topics/groups are removed after runs.
See the main plan for executed API evidence and unverified browser/hardening
work.
