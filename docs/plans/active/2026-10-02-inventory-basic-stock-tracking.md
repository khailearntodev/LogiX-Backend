# Execution Plan: Inventory Basic Stock Tracking Per Warehouse

Date: 2026-10-02

## Status

Active

## Outcome

`inventory-service` exposes tenant-scoped HTTP endpoints that let an authorized
user see on-hand / reserved / available quantity of every product in every
warehouse, and let Warehouse Staff change on-hand through two idempotent write
paths (stock receipt, manual adjustment). Every on-hand change produces exactly
one `StockMovement` row with reference, actor, timestamp; a replayed
`idempotencyKey` produces no second effect; `available` never goes negative.

## Context

- Requirements: `docs/plan_ghi_ro_so_task_backlog/brd.md` — FR-INV-001,
  FR-INV-002, FR-INV-003 (Must), BR-INV-001..BR-INV-003, BO-02.
- Boundaries: `docs/architecture/service-boundaries.md` §3.4,
  `docs/architecture/data-ownership.md` §4.
- Schema (already migrated, no schema change needed):
  [apps/inventory-service/prisma/schema.prisma](apps/inventory-service/prisma/schema.prisma)
  — `InventoryBalance`, `StockMovement`, `StockReceipt`, `StockReceiptLine`,
  `OutboxEvent`.
- Code pattern to copy: `identity-service` feature module layout
  ([apps/identity-service/src/organizations/organizations.controller.ts](apps/identity-service/src/organizations/organizations.controller.ts),
  [apps/identity-service/src/organizations/services/organization.service.ts](apps/identity-service/src/organizations/services/organization.service.ts)) —
  controller + `services/` + `dto/` with `class-validator`, `PrismaService`
  injected directly, Vietnamese error messages, global `ValidationPipe`
  (`whitelist`, `forbidNonWhitelisted`) and prefix `api/v1` in `main.ts`.
- Current state: `inventory-service` has only the `Hello World` stub
  ([apps/inventory-service/src/app.controller.ts](apps/inventory-service/src/app.controller.ts));
  config, logger, `DatabaseModule`, `GlobalExceptionFilter` are already wired in
  [apps/inventory-service/src/app.module.ts](apps/inventory-service/src/app.module.ts).

## Scope

In scope:

- `GET /api/v1/inventory/balances` — list balances filtered by
  `warehouseId` / `productId`, paginated, returns on-hand, reserved, available,
  low-stock threshold and `isLowStock`.
- `GET /api/v1/inventory/balances/:warehouseId/:productId` — single balance.
- `GET /api/v1/inventory/movements` — movement history filtered by warehouse /
  product / reference, newest first (audit trail for BR-INV-002).
- `POST /api/v1/inventory/receipts` — inbound receipt, N lines, one transaction,
  creates/updates balances + one `StockMovement` per line + `StockReceiptLine`.
- `PATCH /api/v1/inventory/balances/:warehouseId/:productId/adjust` — signed
  delta with mandatory `reason`, `ADJUSTMENT_IN` / `ADJUSTMENT_OUT` movement.
- `PATCH /api/v1/inventory/balances/:warehouseId/:productId/threshold` —
  set `lowStockThreshold` (input for FR-INV-004 later).
- Tenant-scoped JWT authentication guard inside `inventory-service`.
- `OutboxEvent` rows (`StockReceived`, `InventoryAdjusted`) written in the same
  transaction as the balance change.

Out of scope (later phases):

- Reservation / release / issue (`ReservationGroup`, `InventoryReservation`) and
  order integration.
- Outbox dispatcher / Kafka publishing and any event consumer.
- Low-stock notification delivery (FR-INV-004) — only threshold + `isLowStock`
  flag here.
- Validating `warehouseId` / `productId` against `master-data-service` (still a
  stub); IDs are accepted as UUIDs only.
- Stocktake / approved count workflow (BR-INV-003 explicitly defers it).

## Approach

1. **Auth + tenant context.** Add `src/auth/` to `inventory-service`: a
   stateless `passport-jwt` strategy verifying `JWT_SECRET` (same token
   `identity-service` issues), `JwtAuthGuard`, `@CurrentUser()` decorator
   exposing `{ id, tenantId, role }`. No cross-service DB lookup. Every query
   and write filters on `user.tenantId` from the token, never from the body.
2. **Domain layer.** `src/inventory/services/`:
   - `inventory-balance.service.ts` — read queries, threshold update,
     `available = onHand - reserved` computed in the mapper (the Prisma field is
     `@ignore`d, so it is not selectable).
   - `stock-movement.service.ts` — the single internal write primitive:
     inside `prisma.$transaction`, lock the balance row
     (`SELECT ... FOR UPDATE` via `$queryRaw`, ordered by `productId` to keep a
     stable lock order), upsert it, insert the `StockMovement` with
     `beforeOnHand` / `afterOnHand`, insert the `OutboxEvent`, bump `version`.
   - `stock-receipt.service.ts` — receipt header + lines on top of that
     primitive.
   - Idempotency: catch the unique violation on
     `ux_stock_movement_idempotency` / `ux_receipts_idempotency` and return the
     stored result instead of erroring.
3. **API layer.** `inventory.module.ts`, `inventory-balances.controller.ts`,
   `stock-receipts.controller.ts`, DTOs in `src/inventory/dto/` with
   `class-validator` (`@IsUUID`, `@IsNumberString`/`@IsDecimal`, `@IsNotEmpty`
   on `reason`). Quantities travel as strings and are converted to
   `Prisma.Decimal` — never `number`.
4. **Bootstrap.** Mirror `identity-service` `main.ts`: `api/v1` prefix, global
   `ValidationPipe`, Pino logger, shutdown hooks, own `PORT`.
5. **Tests.** Unit specs for the movement/receipt/adjustment rules with a mocked
   `PrismaService`; e2e spec against a real database for the transactional and
   idempotency rules.
6. Remove the `Hello World` stub controller/service last, after the real module
   is green.

## Risks And Recovery

- **Concurrent writes on the same balance** could break
  `on_hand >= reserved >= 0`. Mitigation: row lock inside the transaction plus
  the DB `CHECK` constraints as the final guard; a violated check aborts the
  whole transaction, so no partial movement can be written.
- **Decimal precision loss** if quantities pass through JS `number`. Mitigation:
  string DTOs + `Prisma.Decimal` end to end; a unit test asserts a 3-decimal
  value survives a receipt.
- **Duplicate submit** (retry, double click). Mitigation: client-supplied
  `idempotencyKey`, unique index, replay returns the original result.
- **Outbox rows accumulate unpublished** because no dispatcher exists yet. This
  is accepted and documented; rows are durable and replayable when the
  dispatcher lands.
- **Recovery:** the work is additive (new files + `app.module.ts` wiring); no
  migration and no data backfill, so rollback is a revert of the diff.

## Progress

- [x] Step 0 — skeleton: deps, `src/auth/` (strategy, guard, `@CurrentUser`),
      `src/inventory/` (module, 3 controllers, 3 service stubs, DTOs,
      constants, view types), `app.module.ts` wiring, `main.ts` bootstrap
      (`api/v1`, `ValidationPipe`, cookie parser, CORS).
      Build, lint and unit tests pass with the service methods still stubbed.
- [x] Step 1 — read side: `listBalances`, `getBalance`, `listMovements`,
      `updateLowStockThreshold`. Low-stock filter uses raw SQL for the
      column-to-column comparison Prisma cannot express.
- [x] Step 2 — write primitive: `stock-movement.service.ts` with lock,
      movement, outbox, idempotency.
- [x] Step 3 — receipt endpoint + adjustment endpoint.
- [x] Step 4 — unit specs (9 cases on the movement rules).
- [ ] Step 5 — e2e specs against a real database. **Deferred** on 2026-10-03 at
      the user's request, to be written alongside the frontend work. Until then
      atomicity, DB-level idempotency, CHECK constraints and tenant isolation
      are proven only by manual Postman runs, not by an executable check.
- [x] Step 6 — removed the `Hello World` controller/service/spec and the
      placeholder e2e spec; rewrote `apps/inventory-service/README.md` with the
      endpoint list, write rules and known gaps.
- [ ] Step 7 — move plan to `docs/plans/completed/` once Step 5 lands.

## Decisions

- 2026-10-02: Reservation and issue stay out of this phase — "theo dõi số lượng
  hàng hóa theo từng kho" needs only balances plus the two on-hand write paths;
  reservation is only meaningful once `order-service` exists.
- 2026-10-02: `availableQuantity` is read as `onHand - reserved` in the
  application mapper because the Prisma model marks the generated column
  `@ignore`.
- 2026-10-03: Authorization — `inventory-service` verifies the JWT signature
  itself with the shared `JWT_SECRET` and trusts `sub` / `tenantId` from the
  token. It does not query the identity database, which would cross a service
  boundary.
- 2026-10-03: Quantities cross the API boundary as regex-validated strings and
  become `Prisma.Decimal` internally, never JS `number`.

Open — still unresolved:

- **Role policy.** BRD assigns writes to Warehouse Staff and reads to
  "Authorized User", but no repository document maps that to concrete JWT roles.
  Writes currently require an authenticated tenant member only; this gap is
  reported rather than invented. Add a role guard once the mapping is accepted.

## Validation

- Focused proof (`pnpm --filter inventory-service test`):
  - adjustment without `reason` is rejected;
  - an adjustment that would push `available` below 0 is rejected;
  - replaying an `idempotencyKey` creates no second movement;
  - `beforeOnHand` / `afterOnHand` match the delta;
  - decimal quantities keep 3 fractional digits.
- Integration / e2e proof (real Postgres):
  - receipt with N lines is atomic — a failing line leaves no balance change and
    no movement;
  - a balance created under tenant A is invisible to tenant B;
  - movement history returns the receipt and the adjustment in order;
  - low-stock filter returns only balances at or below threshold.
- Repository-required checks: `pnpm lint`, `pnpm typecheck`, `pnpm test`,
  `pnpm build`.

## Result

Pending Step 5.

Delivered on 2026-10-03: the six endpoints listed in Scope, the JWT guard, the
single write primitive, and the receipt/adjustment paths.

Validation observed on 2026-10-03:

- `pnpm --filter inventory-service test` — 9 passed. Covers movement/outbox
  pairing, before/after consistency, 3-decimal precision, zero delta, missing
  adjustment reason, negative on-hand, on-hand below reserved, idempotent
  replay, and lock-before-read ordering.
- `pnpm build` — 15/15 packages successful.
- `pnpm typecheck` — 11/11 tasks successful.
- Manual Postman run against the real database: receipt, replay, adjustment,
  threshold, movement history and tenant isolation behaved as specified.

Pre-existing repository failures, untouched by this work:

- `pnpm lint` fails at `@logix/common`: `oxlint` is not installed in any
  `libs/*` package although each declares `"lint": "oxlint src/"`.
- `pnpm test` fails at `@logix/config`: no `libs/*` package contains a spec
  file, so vitest exits with "no test files found".

Both are repository-wide tooling gaps in `libs/`, unrelated to inventory. They
need their own decision and were not fixed here.

Outstanding risks: the executable proof gap from the deferred Step 5, the
unpublished outbox rows, and the missing role policy.
