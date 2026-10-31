# Delivery trip & dispatch execution

Date: 2026-10-25

## Status

**All five phases complete — G1–G5 PASS in the approved non-browser scope.**
T001–T030 and LS001–LS007 are complete. Phase-specific evidence and limits are
recorded below. No browser/visual validation or shared DB deployment was done.
Use the root specification, five-phase plan and lifecycle/simplification
decisions as authority; do not read secret files.

## Phase 3 outcome and handoff

Completed T013–T018/LS004. The latest results supersede older "Phase 3 future"
statements only within this completed scope. At G3 signoff, Phase 4–5 had not
yet started; their later completion is recorded in the following sections.
Authority: root spec REQ-010–025, route/UI/migration requirements, lifecycle
L-01/L-02 and simplification S-01/S-04/S-05. Service ownership is unchanged.

- Resource exclusivity reuses exactly two partial tenant+vehicle/Driver indexes
  on APPROVED/IN_PROGRESS trips, including deleted rows; no lease table/worker.
- Manual routes have complete permutations, depot round trips, canonical input
  binding and genuine nullable metrics. RoutePlan versions/evidence are immutable.
- Optimizer requests are persisted before HTTP on the existing route models;
  original request/run/input hash and returned metadata are validated. No sample,
  default truck/Driver or fabricated metrics are used. Unknown optimizer outcomes
  retain their request; manual planning remains independent and usable.
- Actor/tenant/action/input-bound signed previews drive explicit approval or
  reasoned override. Commit creates a new approved route version, snapshots,
  pointer/sequence and RouteApproved outbox atomically. There is no route workflow
  status or second approval action. Approval receipts replay before token expiry
  or current-state validation; actor/payload mismatch conflicts.
- Reopen is local optimistic CAS, not another persisted recovery workflow:
  clears pointer/sequence and releases exclusivity before dispatch authority.
  Unknown response requires read-back, not old-version resend or success inference.
  ShipmentCanceled safely invalidates approved trips and preserves history;
  pending/unknown dispatch authority is not silently unlocked.
- DRAFT/APPROVED cancellation releases claims durably before releasing resources;
  approved history remains. Existing Phase 2 command/recovery semantics survive.
- Transport outbox relay publishes the coordinated RouteApproved v2 envelope.
  Actual Agent adapters use real Transport preview/run/version and retain the
  original confirmed token; no fake planner preview or version.
- Frontend trip detail has manual stop ordering, real optimizer request/history,
  approval/override confirmation, reopen and approved cancellation. `/routes`
  redirects to `/transport` under trip-read access. Removed sample API/demo map
  and fabricated source adapter. Routes public components render saved snapshots,
  nullable metrics and explicitly unverified geometry; GeoJSON is reversed
  explicitly, never by coordinate magnitude. Shared Button/Dialog/Alert/Select,
  responsive layouts and light/dark tokens are used.

### Phase 3 observed proof

| Check | Observed result |
|---|---|
| `node scripts/test-trip-integration.mjs --phase3` | 16 real integration scenarios PASS |
| `node scripts/test-trip-integration.mjs` | 18 retained Phase 2 tests PASS |
| Six-package TypeScript unit run | 386 tests / 45 files PASS |
| Optimizer Python | 46 tests PASS |
| Agent route/planner/catalog/http/confirmation Python | 46 tests PASS |
| Transport migration upgrade runner | 63 checks PASS |
| Six packages build/lint; Transport/messaging typechecks | PASS |
| Frontend `pnpm test` | 158 tests / 22 files PASS |
| Frontend lint/typecheck/production build | PASS; 26 pages generated |
| Actual isolated Gateway responses through FE parsers | 4 checks PASS; temporary test removed |
| Four locale dictionaries | 168 Transport + 3 routes-entry leaves each; runtime/key/placeholder parity PASS |

The six pnpm filters are config, messaging, transport-service, master-data-service,
fulfillment-service and api-gateway. Unit breakdown: 34/32/73/57/162/28.
Transport typecheck uses `--rootDir ../..` for existing cross-service fixture
imports. Python optimizer tests run via pytest; Agent proof includes
test_route_tool, test_planner_graph, test_tool_catalog, test_tool_http_client
and test_confirmation_service. Ruff/syntax proof covers changed Python scope;
two existing engine RUF046 style findings are not claimed fixed.

Real topology: Gateway/Transport/Master Data/Identity eligibility/Fulfillment/
Order ownership, PostgreSQL, Kafka, Python optimizer and actual Agent HTTP
adapters. Proof includes resource races across dates, exact decimal equality
and +0.001kg/+0.000001m3 failures, 100-stop/101-entry bounds, permutation,
stale/hash/actor/token/tenant/confirmation failures, lost optimizer response and
restart, immutable history, rejected dispatch authority, duplicate cancellation,
producer disconnect and broker ACK before DB-mark fault with identical eventId
redelivery. New RouteApproved v2 is accepted; unknown unrelated protocols remain
rejected. Runtime fixture IDs and preview token were sanitized.

### Phase 3 migrations, cleanup and limits

Transport migration `20261025145259_phase3_routes_approval_resources` was
generated with Prisma migrate dev --create-only in owned isolated PostgreSQL;
optimizer Alembic revision is `39a641f6adea_production_route_binding_metadata`.
Fresh deploy/status and representative upgrades passed. No prior migrations
were edited, no db push or shared database deployment was performed. Existing
lifecycle legacy REJECTED/SUPERSEDED rollout blockers still apply.
There are no new lease/preview/optimizer-request workflow tables: existing
RoutePlan/request/evidence models carry their own lifecycle data.

Owned containers/staging and temporary proof files were removed. Permanent
regression tests remain. Generated Prisma formatting was checked with the
existing formatter. No commit, browser/visual check, production SLA benchmark,
live external OSRM, external LLM or centralized Audit ingestion is claimed.
Optimizer runtime proof uses genuine OR-Tools with the Haversine fallback;
distance-matrix provider does not prove geometry source, and UI copy says so.
Existing Next middleware deprecation and config unused-z lint warnings remain.
RF008 Phase 3 portions are proved; completion-resource-reuse remains Phase 5,
so its combined checklist is not prematurely marked complete.

Handoff: Phase 4 can consume APPROVED trip fixtures, immutable selected route/
hash/snapshots, resource constraints, signed previews and durable outbox/request
evidence. It must revalidate current authoritative readiness before dispatch.
Approval is not a dispatch decision or Inventory ISSUE evidence.

## Phase 4 outcome and handoff

Completed T019–T024/LS005. **G4 PASS in the approved non-browser scope.**
At G4 signoff, Phase 5 Driver execution remained unimplemented; it is now
completed in the Phase 5 outcome below.

- Order has durable all-or-none batch dispatch grants and exact replay while
  preserving direct single-shipment authorization. Fulfillment persists intent
  and child request IDs before Order HTTP, validates trip claims, stores the
  grant receipt, and commits shipment lifecycle/history/outbox atomically.
- Transport uses its existing `TripDispatch` record as the only dispatch
  orchestrator. Signed preview/confirm binds version, approved route/input and
  manifest. Persisted operation recovery advances the saved intent; pending
  grant/dispatch blocks cancellation, reopen and conflicting manifest changes.
  Trip becomes `IN_PROGRESS` and emits `TripDispatched` only after the complete
  grant/receipt set is verified.
- Public Gateway contract uses raw JSON: `POST
  /api/v1/trips/:tripId/dispatch-preview` and `POST
  /api/v1/trips/:tripId/dispatch`, both requiring
  `transport:trip:dispatch`; `GET
  /api/v1/trips/:tripId/operations/:requestId` requires
  `transport:trip:read` and actively attempts recovery. Pending returns 202;
  durable rejected/completed returns 200. Exact replay remains actor/body-bound.
- Inventory ISSUE remains driven only by `ShipmentDispatched`; `TripDispatched`
  produces no Inventory movement. Real isolated PostgreSQL/Kafka checks cover
  reservation ISSUED state, exact ledger count, Inbox/outbox relay, duplicate
  and re-keyed delivery, producer failure, and broker ACK/database rollback
  replay without a duplicate ISSUE.
- Frontend adds an APPROVED-trip-only permission-gated preview/confirmation
  panel in trip detail, using shared components/theme. Exact confirmation body,
  preview token and request ID persist by tenant/user/trip. Recovery is explicit
  after reload; it never automatically resubmits with a new token/version.
  VI/EN pending, unknown, granted, rejected and committed copy explicitly avoids
  claiming Inventory is issued based on trip commit alone. A pending/unknown
  dispatch intent also blocks the cancel preview/confirm controls and explains
  why until the saved operation reaches a definite outcome.

| Validation | Result |
|---|---|
| Phase 4 Gateway/API/DB/broker dispatch integration | `node scripts\test-trip-integration.mjs --phase4`: **15/15 scenarios PASS** |
| Retained Phase 2 trip regression | `node scripts\test-trip-integration.mjs`: **18/18 PASS** |
| Backend owner unit tests | Messaging 36, Order 247, Fulfillment 163, Transport 73 |
| Adjacent regression unit tests | Inventory 53, Gateway 28, Master Data 57; **657 backend tests total PASS** |
| Backend build/lint/typecheck | Shared messaging build; five service builds; five-package lint; Order/Fulfillment/Transport typechecks PASS |
| FE non-browser | **167 tests / 24 files**, lint/typecheck/production build PASS (26 pages) |
| Locale parity | Four VI/EN source/runtime dictionaries pass duplicate, key, placeholder and provider-resolution checks |

Owner migrations generated with `prisma migrate dev --create-only`, then
deployed/status-checked on owned isolated PostgreSQL:

- Order: `20261025162402_phase4_durable_dispatch`
- Fulfillment: `20261025162508_phase4_durable_dispatch`
- Transport: `20261025162543_phase4_durable_dispatch`

No `prisma db push`, shared-database deployment, or edits to old migrations.
The migration proof covers additive deploy from existing owner migrations and
clean integration deployments; there is no populated historical-row upgrade
fixture or rollback rehearsal. QA containers/logs owned by the batch were
removed; permanent regression tests remain. No browser or visual check ran.
Centralized Audit/Notification consumer acceptance is not claimed.

Phase 4 API scenarios: `apps\transport-service\test\dispatch.e2e-spec.ts`;
isolated runner: `scripts\test-trip-integration.mjs --phase4`. Parent-owned
phase plan is updated with the detailed scenario inventory and evidence. No
separate agent report/checkpoint was created.

## Phase 5 outcome and final handoff

Completed T025–T030 and LS006–LS007. **G5 PASS in the requested non-browser
scope.** This outcome supersedes earlier statements that Phase 5 was
unstarted; historical Phase 1–4 records remain evidence for their own gates.

- Transport exposes tenant-scoped Driver trip list/detail, Driver deliver/fail,
  and Super Admin action-preview plus reasoned confirmation. Driver identity is
  derived from the authenticated user; Super Admin selection remains inside
  the authenticated tenant and does not fabricate a Driver profile or bypass
  stop order/domain rules.
- Deliver/fail only terminalizes the correct next `PENDING` stop on an
  `IN_PROGRESS` trip. The local transaction stores immutable receipt, actual
  actor separately from assignee, stop/trip versions and Outbox event.
  Committed receipt replay precedes expiry/state checks; conflicting actor or
  payload is rejected. The final terminal stop completes the trip and releases
  resource exclusivity in the same transaction.
- Delivery-result messaging uses the canonical strict v2 contract:
  `DeliveryTrip` aggregate; payload includes `stopId`, `outcome`,
  `assigneeUserId` and canonical tenant/trip/shipment/attempt/request binding.
  Actual actor remains event-envelope metadata. Fulfillment validates the
  shipment/trip binding, durably defers early results, semantically
  deduplicates, rejects conflict, and updates Shipment/history/Outbox
  transactionally. Order projection continues from Shipment lifecycle; no
  delivery-result path mutates Inventory or creates a second ISSUE.
- Frontend Driver list/detail routes are under the existing authenticated
  workspace. Guards, sidebar and admin selector use existing tenant context;
  shared components/theme are retained. Outcome recovery preserves exact
  action, body, preview token and request ID within its original tenant/user
  scope. Four VI/EN source/runtime dictionaries were reviewed.
- Prisma migration
  `20261026222454_phase5_driver_terminal_receipts` adds terminal receipt
  persistence/constraints. It was created using Prisma migrate and deployed/
  status-checked on isolated PostgreSQL only. **No `prisma db push`, no edit to
  prior migration, and no shared database deployment.**

| Validation | Result |
|---|---|
| Frontend | `pnpm test`: **177 tests / 25 files PASS**; lint, typecheck and production build PASS. |
| Transport | **88 tests PASS**; Driver API integration with isolated PostgreSQL **16/16 PASS**; build/lint/typecheck PASS (workspace `rootDir` for cross-package fixtures). |
| Fulfillment | **171 tests PASS**; strict delivery-result Kafka/PostgreSQL E2E **2/2 PASS**; build/lint/typecheck PASS. |
| Messaging / Gateway / Order | **40 / 30 / 247 tests PASS**, respectively; related build/lint/type checks passed where run. |
| Completion/resource | Transport API E2E covers multi-stop terminal completion and resource reuse; delivery outcomes introduce no new stock movement. |
| Locales/UI contract | Four dictionaries: duplicate/key/placeholder/provider-resolution parity reviewed; permission/schema/recovery tests pass. No browser/visual run. |
| Migration | Isolated migration apply/status PASS; Prisma migrate only. No shared DB was touched. |

The evidence is layered: Transport API E2E verifies trip lifecycle through
completion/resource reuse, while Fulfillment Kafka/PostgreSQL E2E verifies
delivery-result defer/recovery/projection behavior. **There is no single
end-to-end suite from `CONFIRMED` across every service to Order projection.**
Do not describe the separate suites as that one continuous runtime test. No
FE-adapter-to-live-Gateway test, browser/visual/focus/responsive test,
centralized Audit ingestion test, or production rollout is claimed.

Cleanup: owned isolated databases/brokers/instances were removed; permanent
regression tests remain and no temporary test page/artifact was retained.
Existing Next middleware convention deprecation warning is non-fatal. No
production deployment was performed. For detailed task mapping and
non-browser acceptance limits, see the Vietnamese
[five-phase implementation artifact](../../../../delivery-trip-dispatch-implementation-phases.vi.md)
and [lifecycle refactor artifact](../../../../delivery-trip-dispatch-lifecycle-refactor.vi.md).

## Historical lifecycle foundation evidence

**Execution update:** LS001–LS003 are complete, with the foundation gate PASS
for Phase 3 development. LS004–LS007 remain future Phase 3–5 work, not this foundation batch.
The documentation-only evidence below is historical. Keep permanent regression
tests per harness; delete only scratch test files and owned temporary resources.
Do not read local secret files or deploy into shared databases for this batch.

Frontend baseline: 126 tests / 14 files passed. Added lifecycle/URL/read-contract
tests and proposal-only SSR/locale proof first: six failed for the intended old
status/approval behavior. Frontend implementation now reads five trip states
and three stop states, rejects PLANNED/ARRIVED, preserves legacy arrival fields,
and removes independent RoutePlan.status plus timer-based fake approval/override.
The optimizer summary is explicitly proposal-only until Phase 3, with shared
Button/Alert/Badge, theme tokens and source/runtime VI/EN. Existing optimizer
sample/data productionization remains a Phase 3 responsibility.
Observed final frontend proof: 134 tests / 15 files, lint, typecheck and production
build passed. Existing Next middleware deprecation warning remains; no browser
or real visual proof is claimed.

Backend final proof:
- `pnpm --filter transport-service test`: 13 files / 45 tests passed.
- Transport `test:trips:integration`: 1 file / 18 tests passed, including
  runtime trip read/filter contracts and Phase 2 command regressions.
- Driver regressions: 3 files / 26 tests passed.
- Fulfillment regressions: 4 files / 52 tests passed (not 77).
- Transport `test:migrations:upgrade`: 46 checks passed.
- Messaging `vitest run src/interfaces/transport-contract.spec.ts`: 1 test passed.
- Transport lint/build and messaging typecheck passed. Build excludes specs;
  no separate spec-only TypeScript count or check is claimed.

Migration [20261025140510_delivery_trip_lifecycle_foundation](../../../apps/transport-service/prisma/migrations/20261025140510_delivery_trip_lifecycle_foundation/migration.sql)
was generated with Prisma migrate dev --create-only in owned isolated
PostgreSQL, never db push. PLANNED becomes DRAFT only without dispatch evidence;
ARRIVED becomes PENDING only without completion/attempt evidence. Historical
arrivedAt/currentAttempt, approved pointers, approver/time and route/input/
vehicle/driver/depot snapshots are preserved. RoutePlan.status and its
approved-status index are removed; terminal attempt outcomes are constrained.
REJECTED/SUPERSEDED rows block rollout until actual decisions are preserved
through Audit and approved cleanup resolves source rows. No fabricated
approver/time, audit records or replacement workflow flag is introduced.
Unsafe/pending evidence fails closed; shared deployment needs an authorized
maintenance window and data review. Do not run the old binary after migration.

Read contracts now expose five trip states and three stop states. STOP_ARRIVE
is removed from action-preview contracts; TripPlanned is deprecated legacy,
not a new producer. ShipmentCanceled no longer writes RoutePlan.status.
No approval, dispatch or Driver execution mutation was implemented early.
Local draft/cancel/claim/recovery semantics and service ownership remain.
All four dictionaries pass 119 Transport and 13 route-summary key parity.

Cleanup confirmed: owned integration PostgreSQL containers and staging/config
files removed; only pre-existing logix-kafka-1 and logix-postgres remain.
Both repository diff checks passed (line-ending warnings only). No shared
database deployment, browser test or commit was performed. Permanent
regression tests are retained under the harness; scratch resources are gone.

### Historical lifecycle decision — documentation-only stage

2026-10-25 owner decision: follow the Vietnamese
[lifecycle refactor artifact](../../../../delivery-trip-dispatch-lifecycle-refactor.vi.md)
L-01–L-04 / LS001–LS007. Drop Trip PLANNED; keep route planning in DRAFT,
acquire vehicle/Driver exclusivity only on approval; reopen APPROVED to DRAFT
and release resources atomically before pending dispatch/grant. Remove the
independent RoutePlan status workflow; use immutable versions/approval evidence
and the trip's approvedRoutePlanId. Remove ARRIVED/arrive actions; allow the
next PENDING stop to DELIVERED/FAILED on an IN_PROGRESS trip. DeliveryAttempt
is an immutable terminal result/command receipt, not a retry-delivery workflow.

At the preceding documentation-only stage, no lifecycle runtime code, generated
Prisma client, schema or migration was changed or executed. LS001–LS003 were
pending prerequisites before T013 business implementation; LS004 belongs to
G3, LS005 to G4, LS006–LS007 to G5. Prior G1/G2/GR evidence is retained and
does not prove this new behavior. The existing five phases/30 tasks/12
completed tasks and seven completed RF tasks are unchanged.

Updated owner documents: BRD transport/Driver lifecycle, database design §10,
root spec/phase plan/persistence refactor, service README and frontend domain
contract. Historical execution notes below retain their original terminology.
Do not change harness, service ownership, role rules, stock ISSUE source,
irreversible grants, receipts, snapshots or outbox/inbox guarantees.
Only Prisma migrate may create/deploy migrations; never db push.
Every subsequent UI change includes source/runtime VI/EN, shared components
and theme/code-style review. No browser validation is claimed.

Documentation validation observed: 10 edited/new documents, 182 existing local
file-link targets, five functional phases, 30 original tasks with 12 historical
completions, all 60 requirement mappings, seven historical RF completions and
seven pending LS tasks. Target spec no longer declares a PLANNED state row,
arrival transition or arrive endpoint. Backend/frontend scoped git diff checks
passed; Git reported only its existing LF-to-CRLF normalization warning for
the event architecture document. No application tests/builds or migrations
were run for this documentation-only change.

2026-10-25 simplification request: [whole-task refactor artifact](../../../../delivery-trip-dispatch-simplification-refactor.vi.md)
defines S-01–S-08 and RF001–RF011. RF001–RF007 are complete;
**GR PASS within the approved non-browser scope.** Source and migration are
ready for Phase 3 development; shared-environment deployment was not performed.
Phase 3 implementation remains out of scope. Prior G1/G2 results remain historical evidence for the
pre-refactor implementation, not proof of the new token/CAS/derived-demand design.

Phase 2 completed by explicit user request: T007–T012, draft trips and shipment
membership/recovery, cancel and dispatcher UI; G2 PASS. Baselines at start:
Backend `fe3dd2e`, Frontend `cd82289` (clean committed Phase 1/D-14 worktrees).

2026-10-25 follow-up: D-14 addition to T004–T006 (mistaken user-link correction) implemented and validated within the non-browser scope. Prior G1 counts below cover the original batch; extension evidence is recorded separately at the end.

## Outcome and authority

Implement the five-phase [execution artifact](../../../../delivery-trip-dispatch-implementation-phases.vi.md) and [specification](../../../../delivery-trip-dispatch-spec.vi.md). T001–T030, RF001–RF007/GR and LS001–LS007 are complete within their recorded scopes. Phase-specific evidence and boundaries are retained below. Backend/Frontend AGENTS, WORKFLOW, architecture and API contracts remain authoritative. No browser testing by explicit request.

## Scope and sequence

- T001: contract inventory/owner documentation, distinguish target from live APIs.
- T002: versioned runtime contracts, permissions and safe catalogue provisioning.
- T003: existing BE runner fixtures and FE non-browser/locale runner.
- T004: tenant-scoped, authorized Driver CRUD and Identity lookup through APIs, Gateway wiring.
- T005: Driver management/picker in FE with shared components/theme and four VI/EN dictionaries.
- T006: focused/regression tests, migration status, handoff evidence.

No trip execution UI, solver rewrite, batch dispatch implementation, POD or Telegram in this batch.

## Risks and recovery

No cross-service DB reads in application code; no automatic account seed or destructive DB reset. Only Prisma migrate may produce migrations if needed. Preserve existing changes. Do not claim G1 complete without real Gateway/persistence proof. Test resources must be isolated and stopped after use; persistent regression tests remain, scratch resources are removed.

## Refactor RF001–RF007 execution

- Authority: whole-task refactor S-01/S-02/S-03/S-08, with unchanged BE/FE
  harness and service ownership. No Phase 3 runtime code is included.
- Baseline: frontend `pnpm test` passed 122 tests / 14 files before edits.
  Transport unit 26/26 and migration-upgrade 12 checks passed before edits.
  Initial trip integration had 16/17 passing: Driver relink race returned 502
  rather than expected 201/409. Final trip and Driver suites passed; the
  baseline failure is disclosed, not erased or treated as a passing baseline.
- FE consumer inventory: transport API/schema, draft metadata/assignment panels,
  cancellation dialog and tenant/user-scoped session intent storage. No new
  Agent tool is introduced. Endpoint paths remain unchanged.
- FE local edits use explicit read-back after unknown outcomes, not exact
  success replay; unchanged Driver references are omitted from vehicle edits.
  Driver-reference commands retain the stronger path. Signed cancellation
  keeps its exact saved body for explicit retries, including after expiry.
- Current FE proof: 126 tests / 14 files, lint, typecheck and production build
  passed. All four Transport dictionaries have 116 leaves, key/placeholder and
  runtime parity tests pass. Existing Next middleware deprecation warning only.
  Shared Button/Alert/theme tokens are reused. No browser/visual proof claimed.
- New cancellations require `previewToken`. A saved legacy `previewId` intent
  has a separate replay-only validator/adapter: it may recover its committed
  receipt; it cannot authorize a new cancellation. A definitive validation
  rejection clears the stale intent so the user can preview/confirm again.
- Backend implementation: signed cancel tokens (300 seconds), pinned HS256/
  issuer/audience/purpose and actor/tenant/trip/version/hash binding. Required
  `TRIP_CANCEL_PREVIEW_SECRET` is at least 32 characters and startup rejects
  reuse of either JWT secret. Existing `jsonwebtoken` ecosystem is used, not
  custom cryptography. Legacy `previewId` is accepted for exact receipt replay
  only, otherwise rejected as refresh-required without reading a preview table.
- Local edits include omitted/null Driver; a non-null Driver (also mixed PATCH)
  retains its durable path. Pending exclusions, create/Driver identity locking,
  claim/release compensation and historical receipts remain.
- New migration:
  `20261025123352_simplify_cancel_preview_and_stop_demand`, generated with
  `prisma migrate dev --create-only` against an owned isolated database.
  Drops one preview table and two stop-demand columns. Deterministic backfill
  preserves membership demand; orphan/ambiguous matches and conflicting nonzero
  values fail rather than discard or guess. Upgrade rehearsal covers pending
  operations, remove/re-add, preserved history and unsafe-data rejection.
  No prior migration was edited, no `db push`, no shared DB touched.
- Observed post-change backend proof: Transport unit 38/38, lint/build passed;
  upgrade rehearsal 23 checks; real trip integration 18/18; real Driver
  integration 19/19 across five files. Fulfillment isolated-stack query,
  lifecycle, cancellation and trip-claims tests: 77/77 across four files;
  includes downstream dispatch, Inventory ISSUE and delivery/failure, not only
  mocked service tests. Fulfillment, Order, Inventory and Gateway builds pass.
- Transport source/test typecheck passed from the owning service directory:
  `pnpm exec tsc --noEmit -p tsconfig.json --rootDir ../..` (workspace source
  imports require the rootDir override). Lint passed again; generated-only
  Prettier formatting removed generator trailing whitespace; diff checks pass.
  **RF001–RF007 / GR PASS** within the non-browser isolated-runtime scope.
  No shared database/environment or account was
  modified. Only pre-existing shared `logix-kafka-1` and `logix-postgres` were
  observed after isolated runner cleanup.

### Refactor deployment and Phase 3 handoff

Reproducible commands (backend repository root unless stated):

```text
pnpm --filter transport-service test
pnpm --filter transport-service test:migrations:upgrade
pnpm --filter transport-service test:trips:integration
pnpm --filter transport-service lint
pnpm --filter transport-service build
pnpm --filter master-data-service test:drivers:integration
pnpm --filter fulfillment-service test:e2e test/pick-pack.query.e2e-spec.ts test/pick-pack.lifecycle.e2e-spec.ts test/pick-pack.cancellation.e2e-spec.ts test/trip-claims.e2e-spec.ts --no-file-parallelism
```

Frontend root: `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build`.
Final proof includes 134 valid local documentation links, all 60 refactor
requirement mappings, unchanged original five phases/30 tasks/12 historical
completions, and seven completed RF tasks with four future RF tasks pending.

- Deployment to a shared/developer/production environment was not authorized or
  performed. Configure the dedicated preview secret, coordinate BE/FE rollout,
  drain/recover pending operations and rehearse that environment's data before
  `prisma migrate deploy`. Old unconfirmed previews require refresh; committed
  old command receipts remain replayable. Do not start an old binary against
  the contracted schema; recover by forward fix or authorized verified restore.
- Phase 1 remains unchanged except regression proof; no Driver-role addition,
  authorization bypass, cross-service database read or shared harness change.
- RF008–RF011 and T013–T030 remain unimplemented. GR opens Phase 3 development;
  it does not replace the original optimizer contract prerequisite or G3 proof.

## Decisions

- Ordinary Driver update keeps user linkage immutable. D-14 authorizes a dedicated relink command only before any trip reference, with expected-old/version, reason, backend preview, explicit confirmation and atomic audit. Create/relink validate active Identity membership and Driver capability through an authenticated service API. User names are resolved from Identity and never fabricated.
- Super Admin permission exemption is not a domain/tenant bypass; target context uses existing verified Identity flow.
- FE non-browser Vitest runner is within the approved Phase 1 scope; no browser packages.

## Progress

- [x] T001 — technical targets recorded in database-design §10.8 and event-architecture §14; no Phase 2 product-decision blocker. Later implementation evidence remains required.
- [x] T002 — runtime schemas/hash bindings, typed permission catalogue and catalogue-only provisioning; no account seed run.
- [x] T003 — reproducible isolated PostgreSQL/API and Kafka 4.1.1 helpers; FE non-browser/locale runner, no success-shaped infrastructure skips.
- [x] T004 — Driver CRUD, versioned status/update, immutable user linkage, verified internal Identity lookup and public Gateway.
- [x] T005 — guarded workspace Driver management, eligible-user picker and API/schema exports; same shared primitives/theme and four locale dictionaries.
- [x] T006 / G1 — final module/API/contract/locale/permission proof, builds and resource cleanup passed.

## Validation

Environment observed: Node 22.19.0, pnpm CLI 11.25.0 (BE workspace selects pinned 11.6.0), Docker daemon 29.7.2 responds.

- Initial baseline: Master Data 10 tests, Gateway 14 tests passed.
- Messaging: 10 new contract/hash tests; full source-only unit suite 26 tests passed (compiled duplicates excluded); typecheck/build/lint passed. `pnpm --filter @logix/messaging test:integration`: 1 real roundtrip passed against cached production-parity `apache/kafka:4.1.1`, 0 skipped, owned container removed. Missing prerequisites fail explicitly; shared topics/broker untouched.
- Auth: 32 tests/build passed; one existing lint warning.
- Identity: full 166 tests across 15 files, lint and build passed (exit 0).
- Gateway: 19 tests across 3 files, lint and build passed (exit 0).
- Master Data: 35 unit tests, full source/test typecheck, lint, build and final canonical API rerun passed (exit 0).
- Real Gateway → Driver service → signed Identity HTTP → PostgreSQL: 5 tests across 4 files passed, including the retained application smoke suite. Includes create/read/update/status, independent code/user/license uniqueness conflicts, stale/concurrent version updates, active capability membership, unauthorized/cross-tenant rejection, admin selected tenant, historical names and internal caller boundary.
- Isolated PostgreSQL 17 migrations deploy/status passed for Identity and Master Data. Historical migrations need schema-specific URL query parameters; no schema change/new migration needed in this phase, no `db push`, no shared database reset.
- `pnpm --filter master-data-service test:drivers:integration` owns ephemeral HTTP listeners and its uniquely named database container. Teardown removed the owned container; shared PostgreSQL/Kafka were not modified.
- Retained the application smoke suite, replacing the obsolete generated `GET / -> Hello World` assertion (no such production controller) with real Gateway authentication/tenant/internal-route assertions. No existing test file is deleted to bypass checks. Permanent regression tests/fixtures stay in source; no QA accounts remain in shared data.
- During development: corrected isolated migration search paths and Identity fixture status; increased CLI hook/test timeout under shared-host load. Final passing runs supersede failed attempts; assertions were not skipped or weakened.
- Browser/visual testing: NOT_RUN by explicit request. No browser packages installed.
- FE: final `pnpm test`: 38 tests / 5 files passed, including 6 Driver locale checks and render-based route/read/manage/unknown-permission and shared default-behavior checks. `pnpm lint`, `pnpm typecheck`, `pnpm build` passed (exit 0); build includes `/master-data/drivers`. Existing middleware deprecation warning remains; no new lint/typecheck errors reported.
- FE shared form/dialog/page changes are opt-in; existing default behavior retained and tested. HTTP error parsing only adds optional `details.code` extraction from the existing envelope. I18n lookup/fallback/interpolation was extracted without changing semantics; runtime resolution uses the real provider. Changed Driver keys match all four dictionaries (duplicate Driver keys, VI/EN keys/placeholders, source/runtime parity and used-key resolution checked).
- Real browser rendering and FE adapter-to-live-Gateway execution were not run; FE adapter/schema fixtures were checked against the same response/error shapes verified through the real Gateway API suites. These levels of proof are not interchangeable.

## Deployment / next-phase prerequisites

- Configure validated `IDENTITY_SERVICE_URL` as a service origin and matching `INTERNAL_SERVICE_JWT_SECRET` for Master Data/Identity; `MASTER_DATA_SERVICE_URL` is required at Gateway. See owning service READMEs and Master Data `.env.example`; no secrets/defaults were committed.
- Provision only the permission catalogue with `prisma/provision-permissions.js` in an authorized Identity environment; explicitly grant roles via existing IAM. No existing role grants or shared account data were changed automatically.
- Ephemeral Driver IDs from tests are intentionally not reusable production IDs; reuse committed fixture setup to obtain new isolated records in Phase 2.
- The original G1 handoff treated Transport contracts as targets. G2 now implements draft claim/release/cancel preview/Inbox/recovery below; grant/approval/optimizer/results and their later-phase convergence proof remain pending.

## Result

Phase 1 is implemented and verified in the requested non-browser scope. Phase 2 can start using the committed target contracts and reusable isolated fixtures. No product-decision blocker remains for that phase; no external-owner signoff or future production protocol implementation is implied.

No shared application database or production permission grants were changed. No test QA accounts, ad-hoc test pages or scratch scripts remain; committed regression helpers are intentional deliverables of T003/T006. No commit was created.

## D-14 extension — PASS, non-browser

Authority: explicit user request to update artifacts and fully implement mistaken-link correction; [specification §6.5](../../../../delivery-trip-dispatch-spec.vi.md#65-sửa-liên-kết-tài-khoản-driver-bị-chọn-nhầm--bổ-sung-phase-1), D-14 and expanded REQ-014.

- [x] Backend preview/confirm, authenticated usage and permanent linkage lock, atomic audit outbox, migrate-generated schema changes. Both public endpoint request/response shapes match the FE contract.
- [x] Frontend dedicated managed action, old/new preview, reason, frozen confirm body, permission/tenant/session guards and all four VI/EN dictionaries. FE worker reports 95 tests / 7 files, lint/typecheck/build/diff-check exit 0; no browser or live-backend adapter invocation.
- [x] Real API/migration/race/audit tests and non-browser FE tests; owning docs, evidence and cleanup.

Safety: query Identity/Transport before local transaction; relink CAS and permanent lock serialize locally, no DB transaction spanning HTTP. Transport must lock with expected user/version before any future reference, including drafts. Historical usage query catches pre-lock references and fails closed on outage. No automatic permission grants, unlocking after cancellation, force override or cross-service DB reads.

Contributors own independent BE and FE implementations/tests; this is the sole durable execution record. Root artifacts are maintained here by the parent.

### Extension validation and limits

- Master Data unit: 57 tests / 6 files PASS; Transport unit: 5 tests / 3 files PASS; Errors library: 18 tests / 2 files PASS.
- `pnpm --filter master-data-service test:drivers:integration`: 19 tests / 5 files PASS using real HTTP boundaries and isolated PostgreSQL. Covers relink, deleted/historical drafts, authorization, eligibility, concurrent mutations, both linkage-lock race outcomes, upstream outage and audit-insert failure rollback.
- Master Data and Transport full typecheck/lint/build: exit 0. FE `pnpm test`: 95 tests / 7 files; lint/typecheck/build: exit 0. Browser and FE-adapter-to-live-Gateway execution NOT_RUN; API runtime and FE adapter/schema proofs are separate.
- Prisma migrations generated exclusively with `prisma migrate dev` against owned isolated PostgreSQL: Master Data `20261025085219_driver_user_relink_lock_outbox`, Transport `20261025085228_driver_history_lookup`. Existing Phase 1 statement “no schema change” is historical, not applicable to D-14. No `db push`, shared DB reset or account/role grant was performed.
- Final parent `git diff --check` passed for both repos; only existing line-ending conversion notices. Container inventory contains only the existing shared `logix-postgres` and `logix-kafka-1`; no owned test instance remains.
- Audit proof is durable atomic **local outbox evidence**, not verified centralized audit-service ingestion. Central relay/consumer delivery is not claimed. Existing Next middleware deprecation warning remains.
- Phase 2 is still unimplemented and MUST lock the identity before all trip references. Existing historical references are queried via Transport; any legacy writer needs a rollout fence. Permanent linkage locks are not leases and never released by cancellation.

### Extension schema and deployment handoff

- Master Data adds nullable `Driver.linkLockedAt` (`link_locked_at`, timestamptz) and standard `master_data.outbox_events`, indexed by tenant/aggregate/version and publication/retry scheduling. Existing Driver unique constraints are unchanged.
- Transport adds nonpartial `(tenant_id, driver_id)` index `ix_trips_driver_history`; no new trip mutation flow is introduced.
- Internal `GET /api/v1/internal/drivers/:id/usage` is signed Master Data → Transport, returns `{tenantId,driverId,used}` including all historical/deleted rows. Internal `POST /api/v1/internal/drivers/:id/link-lock` is signed Transport → Master Data with `{version,expectedUserId}` and returns `{driverId,userId,version}`; same-binding retry succeeds without incrementing version or resetting the lock. Neither endpoint is public Gateway routing.
- New required Master Data `TRANSPORT_SERVICE_URL` is a validated service origin. Transport now requires matching `INTERNAL_SERVICE_JWT_SECRET`; configure these before startup and apply both committed migrations via migrate deploy in an authorized environment. Shared infrastructure was not migrated by this task.
- Atomic local outbox event is `DriverUserRelinked` v1, aggregate `Driver`; actor is from JWT and before/after store user IDs/versions, not names/email. Test forces a real outbox-insert constraint failure and proves Driver/version rollback and zero audit events.

## Shared-document scope review

User requested a review of documentation consumed by the system-wide harness.
No AGENTS, WORKFLOW, harness templates, CI, runtime code or database behavior
was changed in this documentation review.

- Data ownership retains system-level account/profile/history/audit boundaries;
  the permanent Driver identity lock is explicitly a domain-specific rule.
- Database design retains persistence invariants under the relevant domain,
  removes batch-progress columns, export inventories and provisioning commands,
  and links to the owning code/service runbook.
- Event architecture distinguishes common envelopes/outbox ownership from
  Transport versions and the Driver audit event; status evidence stays here.
- The shared FE API contract now links to the separate
  [Driver management API contract](../../../../LogiX-Frontend/docs/product/driver-management-api.md).
  Domain endpoints, permissions and workflow details are no longer embedded
  in the shared Errors section.
- Corrected Driver error documentation against GlobalExceptionFilter:
  domain codes are in top-level `error`, not required `details.code`.
  Relink preview is validation/display; Transport command preview is persisted,
  not claimed to be a cryptographically signed token.

Validation for this review: documentation links/headings and both repository
diff checks; application tests need not rerun because no runtime files changed.

## Phase 2 — complete; G2 PASS (non-browser)

- [x] T007: draft nullable resources, durable membership/operation/receipt schema and history-safe migration.
- [x] T008: Fulfillment claim/release/status and filtered pool, direct-dispatch exclusion.
- [x] T009: Transport APIs/orchestration, frozen snapshots, Driver identity lock, Gateway.
- [x] T010: cancel preview/confirmation, release recovery and ShipmentCanceled consumer/Inbox.
- [x] T011: workspace draft-trip UI, exact adapters/schemas, all four locale dictionaries.
- [x] T012 / G2: real API/PostgreSQL/Kafka, race/restart/regression and FE non-browser proof.

Execution ownership: Fulfillment and Transport implementations plus FE are
independent contributor scopes; parent owns Gateway, cross-service integration
proof, artifact/report updates and final gate. No second task database/plan.
No root API contract shell script was found; required endpoints derive from
specification §7.2 and must be runtime-verified. Preserve the Phase 1 regression
suites and distinguish permanent test infrastructure from disposable QA files.

Gateway targeted proof: 28 unit tests / 4 files, lint and build passed.
Existing proxy e2e: 18 tests / 2 files passed after supplying all required
targets and replacing the old external registration probe with an owned
loopback upstream. Initial fixture/config failures were fixed without relaxing
assertions; this is proxy proof, not Identity persistence proof.

Final contributor checks: Fulfillment 162 unit tests and four real
HTTP/PostgreSQL tests passed; Transport 26 unit tests / 11 files passed,
including explicit stop-view allowlisting and assignment HTTP 200.
Their lint/build/type checks passed.
FE 122 tests / 14 files, lint/typecheck/build passed; 113 Transport leaf keys
match across all four dictionaries. Routes: `/transport`, `/transport/new`,
`/transport/[tripId]`. Shared components and semantic theme/responsive classes
were source-reviewed, not browser-tested.

Driver/relink regression after the Gateway/test-fixture extension: 19 tests /
5 files passed; all four existing service migration statuses were current on
the owned isolated DB, and the runner removed that PostgreSQL container.
Cross-service final acceptance: `pnpm --filter transport-service test:trips:integration`
passed 17 tests / 1 file, zero failed/skipped. The runner deployed and checked
all five service schemas in one owned PostgreSQL 17 database, started real
Gateway/Transport and signed Master Data/Fulfillment HTTP plus an owned Kafka
4.1.1 broker. It exercises every public endpoint of this phase, auth/tenant
fail-closed behavior, frozen snapshots, exact Decimal totals, competing trip
claim, pre-pagination pool exclusions, failed-batch compensation, remove/re-add
history, permanent Driver link lock and actual first-reference/relink API race,
lost claim/remove/cancel responses,
restart before and after upstream commit, and duplicate ShipmentCanceled Inbox
convergence. Trip cancellation preserves the seeded confirmed Order and emits
no Order reservation-release request.

Runtime findings were fixed rather than bypassed: active membership uniqueness
now maps to a domain conflict; canonical address fields and fixed decimal scale
match Fulfillment; snapshot-parse failure durably retains and compensates a
verified claim; ShipmentCanceled release uses the event shipment version.
Re-add intentionally preserves the old RELEASED membership and creates a new
ACTIVE row while reusing the historical stop identity.

Error contract: stale trip version is 409 CONCURRENCY_CONFLICT; conflicting
replay/pending membership/compensated rejection use contextual 409 rules.
Invalid/expired or digest-stale cancel preview intentionally uses 422
BUSINESS_RULE_VIOLATION. Persisted rejected operation GET is 200/REJECTED.
Unknown side effects remain 202/PENDING and retain local mutation/pool locks.

Migration upgrade: `pnpm --filter transport-service test:migrations:upgrade`
passed 12 checks over Phase 1 migration deployment, legacy row seeding and
both new Transport migrations; original history/defaults/nullability/unique
and FK behavior verified. New migrations were created with Prisma migrate on
owned isolated DBs:

- Transport `20261025095046_phase2_trip_draft_membership_operations`.
- Transport `20261025095334_trip_membership_operation_binding`.
- Fulfillment `20261025095506_add_shipment_trip_claim_receipts`.

No db push, shared DB migration/reset, role grants or production QA data.
The unchanged existing `test/pick-pack.lifecycle.e2e-spec.ts` also passed
16/16 real isolated-stack tests: start-picking, mark-ready, unassigned
direct-dispatch preview/command and delivered/failed paths. Fulfillment,
Order, Inventory and Gateway builds passed for this run. It used the existing
stack fixture with `PICK_PACK_STACK_E2E=1` and cached PostgreSQL 17; all owned
stack containers were removed afterwards.

Final cross-service fixture typecheck with workspace rootDir, Transport lint,
runner syntax and non-generated source diff checks passed. Prisma-generated
files retain generator formatting. FE full 122-test result remains current
after the final error-contract documentation update.

Cleanup verified: no owned QA PostgreSQL/Kafka containers remain; only the
pre-existing shared `logix-postgres`/`logix-kafka-1` were observed. Permanent
test runners/fixtures/regressions remain intentionally; temporary containers,
HTTP listeners and migration staging were removed.

### Phase 3 handoff

This original G2 handoff now requires the additional GR simplification gate
before implementation of T013; see the next section. Existing API behavior
remains unchanged until the refactor is implemented and runtime-verified.

Configure Gateway `TRANSPORT_SERVICE_URL`, Transport Master Data/Fulfillment
origins, matching user/internal JWT secrets and Kafka broker/topic/group keys
from service READMEs and examples. Apply reviewed migrations with Prisma
migrate deploy only. Do not auto-provision user/role access.

Only ACTIVE manifests with completed operations are valid Phase 3 inputs.
Draft vehicle/Driver references are optional; their approval snapshots and
resource leases are not implemented yet. No approve/dispatch/optimizer or
Driver execution UI is claimed. Browser/visual, FE adapter-to-live-Gateway,
centralized audit ingestion and full production stock-ledger convergence
remain outside this gate. Shared harness/AGENTS/WORKFLOW/CI were not changed;
shared FE API documentation adds only a neutral domain-contract link.

## Whole-task simplification — historical design-only checkpoint

The user explicitly requested a separate Vietnamese refactor artifact and
alignment of the feature artifacts. The linked artifact is a design input,
not a competing execution/progress plan. The original five phases/30 tasks/60
requirements remain; RF tasks are subordinate refactor work.

- S-01: replace persisted cancel preview with purpose-bound signed preview
  tokens; no per-action preview tables. Preserve backend validation,
  reason/confirmation, command idempotency and committed replay before expiry
  validation. No independent preview revocation/single-use claim.
- S-02: remove new operation writes only for classified local draft edits;
  version/CAS plus read-back after timeout. Retain create/Driver binding and
  all existing durable claim/release/cancel semantics and historical replay.
- S-03: derive stop demand from authoritative memberships, freeze plan inputs;
  remove two redundant stop columns only after legacy-data proof.
- S-04/S-05: future resource exclusivity via partial uniqueness on trip if
  state-bound; reuse RoutePlan for request/proposal/override/approval versions.
- S-06/S-07: TripDispatch alone owns Transport dispatch orchestration;
  preserve Order/Fulfillment batch authority/receipts, Inventory ISSUE,
  ARRIVED/terminal idempotency and durable result processing.
- S-08: retain Phase 1 Driver permanent link lock/audit/auth, require a concrete
  owner/cardinality/failure/test reason for each new support table.

At this earlier documentation checkpoint, RF001–RF007 / GR: NOT_STARTED.
This historical state is superseded by the GR acceptance section above.
RF008–RF011: future Phase 3–5 constraints,
NOT_STARTED. No migration, API, permission or locale-runtime change was made.
Do not drop old migrations/receipts, edit system harness, or introduce generic
workflow infrastructure. Prisma migrate only; no db push.

Documentation validation must verify links, exactly five functional phases,
30 unique T-tasks with 12 historical completions, and 60 requirements in both
the functional and refactor mappings. Browser remains excluded. Runtime tests
will be required when refactor code is implemented, not claimed from this edit.

Documentation-only validation completed: five related documents / 133 local
links resolve; all 60 spec requirement IDs are mapped exactly once in the
refactor artifact; 11 unique RF tasks are pending. The original five functional
phases, 30 T-tasks and 12 historical completions are unchanged. Both repository
documentation diff checks passed. No application tests were run for this
documentation-only change.
