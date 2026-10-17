# inventory-service

Owns inventory balances, stock movements and stock receipts for LogiX. One
`InventoryBalance` row per `(tenant, warehouse, product)` carries on-hand,
reserved and low-stock threshold; `available = on_hand - reserved` and never
goes negative.

Authority: BRD FR-INV-001/002/003 and BR-INV-001..003,
`docs/architecture/service-boundaries.md` §3.4,
`docs/architecture/data-ownership.md` §4.

## Endpoints

All routes are prefixed with `/api/v1`, require a Bearer JWT, and are scoped to
the `tenantId` carried by that token. Quantities are strings with up to three
decimal digits; they are never JSON numbers.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/inventory/balances` | List balances. Filters: `warehouseId`, `productId`, `lowStockOnly`, `page`, `pageSize` |
| GET | `/inventory/balances/:warehouseId/:productId` | Single balance; 404 when it does not exist |
| PATCH | `/inventory/balances/:warehouseId/:productId/adjust` | Signed `quantityDelta` with mandatory `reason` and `idempotencyKey` |
| PATCH | `/inventory/balances/:warehouseId/:productId/threshold` | Set `lowStockThreshold` |
| GET | `/inventory/movements` | Movement history. Filters: `warehouseId`, `productId`, `referenceType`, `referenceId`, `page`, `pageSize` |
| POST | `/inventory/receipts` | Inbound receipt with one or more lines, atomic across lines |

## Write rules

- Every on-hand change goes through `StockMovementService.applyMovement`, which
  locks the balance row, writes exactly one `StockMovement` and one
  `OutboxEvent`, and bumps the balance `version` in one transaction.
- `idempotencyKey` is required on every write. Replaying a key returns the
  original result instead of applying the change twice.
- A decrease is rejected when it would make on-hand negative or push on-hand
  below the reserved quantity.
- Adjustments require a `reason`; the database enforces this as well.
- Receipt lines must not repeat the same product within one receipt.

## Internal reservations

`POST /internal/reservations` and `POST /internal/reservations/release` are
outside the public API prefix. They accept only internal tokens issued by
`order-service`, with `inventory-service` as the audience. Tenant comes from
the verified token, never from the body.

Reserve accepts `orderId`, `orderVersion`, `warehouseId`, and
`lines[{orderLineId, productId, quantity}]`, plus the `Idempotency-Key`
`order:{orderId}:v{orderVersion}`. The result is `RESERVED` with a group ID or
`INSUFFICIENT` with decimal-string shortages. No partial reservation is written.
Replay only succeeds for the same active group and identical business content.
Released keys are not reported as reserved.

Release accepts `{orderId}` and is idempotent. Both commands serialize by
tenant/order and lock balances in product order. Neither changes on-hand.
Stock receipt locks also use product order while retaining original line
indices for their idempotency keys.

`POST /internal/reservations/preview` reads current availability without writing
reservations. `GET /internal/reservations/:orderId/active` checks for an active
group in the authenticated tenant; Order uses it to prevent editing an orphan
reservation while reconciliation is pending.

## Events and recovery

- The shared outbox relay publishes to `KAFKA_INVENTORY_TOPIC`, keyed by
  aggregate ID. Rows are locked with `FOR UPDATE SKIP LOCKED`; only the first
  unpublished event of each aggregate is eligible. Broker failures persist
  retry/backoff metadata. Delivery is at-least-once, not exactly-once.
- `StockReceived` includes decimal-string `quantity` and retains
  `quantityDelta` for existing consumers. Reserve/release publish `StockReserved`
  and `StockReleased`, with a group ID and decimal-string item quantities.
- The Order consumer handles `OrderConfirmed` by acknowledging the referenced
  group and handles `OrderCanceled` by releasing any active group. Inbox writes
  commit with the corresponding Inventory mutation.
- The reconciler scans old, active, unacknowledged groups and calls
  `POST /internal/orders/reconcile-reservation`. Only explicit `RELEASE`
  authorizes release, scoped to the scanned group ID. `ACKNOWLEDGE` records the
  confirmation; `KEEP`, HTTP failures and malformed responses retain the group
  and emit logs. Elapsed time alone never authorizes release.
- Kafka handler errors retain the failed offset and restart for redelivery.
  Permanent invalid events currently block their partition until repaired;
  dead-letter handling and broker-restart/load rehearsal remain hardening work.

## Not implemented yet

- Stock issue from reservations (GĐ5).
- Low-stock notification (FR-INV-004); only the threshold and the `isLowStock`
  flag exist.
- Validation of `warehouseId` / `productId` against `master-data-service`.
- Role-based authorization. Any authenticated member of the tenant can write,
  because no accepted document maps BRD roles to JWT roles.

## Local setup

```powershell
docker compose -f ../../infrastructure/docker-compose/database.yml up -d
docker exec -i logix-postgres psql -U postgres -c "CREATE DATABASE logix_inventory;"
pnpm --filter inventory-service db:generate
pnpm --filter inventory-service db:migrate:deploy
pnpm --filter inventory-service start:dev
```

`.env` requires `DATABASE_URL`, `JWT_SECRET` (must match `identity-service`),
`INTERNAL_SERVICE_JWT_SECRET` (must match `order-service`),
`PORT` (3004) and `FRONTEND_URL`.

It also requires the Kafka, outbox and reconciliation keys listed in
[.env.example](.env.example). Provision shared Kafka topics using
[the Kafka runbook](../../infrastructure/docker-compose/README.md) before
starting the service. `ORDER_SERVICE_URL` points to Order's private HTTP
endpoint, not the public gateway. Missing required configuration stops startup.

## Checks

```powershell
pnpm --filter inventory-service lint
pnpm --filter inventory-service test
pnpm --filter inventory-service build
```
