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

## Not implemented yet

- Reservation, release and issue (`ReservationGroup`, `InventoryReservation`).
- Outbox dispatcher: `outbox_events` rows are written but nothing publishes them
  to Kafka yet, so `published_at` stays `NULL`.
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
`PORT` (3004) and `FRONTEND_URL`.

## Checks

```powershell
pnpm --filter inventory-service lint
pnpm --filter inventory-service test
pnpm --filter inventory-service build
```
