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
