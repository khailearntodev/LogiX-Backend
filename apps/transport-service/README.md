<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg" alt="Donate us"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow" alt="Follow us on Twitter"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

### Driver usage / permanent link-lock integration

`GET /api/v1/internal/drivers/:id/usage` is a service-only read endpoint.
The shared internal JWT guard requires an allowlisted `master-data-service`
issuer, Transport audience, valid signature/expiry and UUID tenant. Response:
`{ tenantId, driverId, used }`. It queries **all** tenant+driver DeliveryTrip rows:
draft, canceled, completed and soft-deleted history count. It must never return
unused when the database is unavailable. No cross-service database reads occur.
The `(tenant_id, driver_id)` nonpartial index supports this historical lookup.
The application now uses the `/api/v1` prefix and strict validation.

Set the required values in [.env.example](.env.example). Missing/short internal
secret fails startup; no insecure defaults or usage-disable configuration exist.
Deploy the usage endpoint and migrations before enabling Master Data relinking.

Local startup reads `.env` in the service working directory unless
`DOTENV_CONFIG_PATH` selects another file. Copy all required keys from
[.env.example](.env.example), including optimizer, Kafka and Outbox settings.
Use the same user JWT secret as Identity and the same internal signing secret
as downstream services; generate a separate random preview secret of at least
32 characters. Never commit these local values. Use URLs/broker addresses
reachable from the process: Docker service names are not host-running URLs.
The optimizer does not load `.env` automatically; configure its process
environment separately before using optimization.

## Phase 2 trip drafts

### Lifecycle foundation

The owner-approved [Vietnamese lifecycle artifact](../../../delivery-trip-dispatch-lifecycle-refactor.vi.md)
removes PLANNED and ARRIVED from active Trip/Stop status contracts, removes
RoutePlan's independent workflow status, and keeps DeliveryAttempt outcomes
terminal. The schema migration, read contract and all five feature phases are
implemented in the approved non-browser scope.

Trip planning remains in DRAFT. GET `/trips` accepts the five target statuses:
`DRAFT`, `APPROVED`, `IN_PROGRESS`, `COMPLETED`, and `CANCELED`; PLANNED is
rejected as a query filter. Stop reads accept only `PENDING`, `DELIVERED`, or
`FAILED`. `arrivedAt` and `currentAttempt` remain read-only compatibility
fields; no new arrival endpoint or mutation is available. RoutePlan approval
evidence (`approvedBy`, `approvedAt`, trip pointer, and existing snapshots)
remains; no independent status field is exposed.

Reopen/resource exclusivity and approval are Phase 3 behavior; durable dispatch
is Phase 4; Driver delivery lifecycle is Phase 5. Existing Phase 2
draft/cancel/claim/release/recovery semantics remain unchanged. Preserve
historical receipts/snapshots; generate migrations with Prisma migrate, never
`prisma db push` or edited old migrations.

### Phase 4 durable dispatch

Gateway prefixes these routes with `/api/v1`:

| Method and path | Permission | Body |
|---|---|---|
| `POST /trips/:tripId/dispatch-preview` | `transport:trip:dispatch` | `{version}` |
| `POST /trips/:tripId/dispatch` | `transport:trip:dispatch` | `{requestId,version,previewToken,confirmed:true}` |
| `GET /trips/:tripId/operations/:requestId` | `transport:trip:read` | None |

Preview returns `{tripId,version,approvedPlanId,inputHash,dispatchVersion,
shipmentCount,previewToken,expiresAt}`. Signed previews expire after 300 seconds
and bind tenant, actor, trip and the complete current selection. Confirm repeats
readiness, approved-route and active-resource validation. Contracts are defined
in `libs/messaging/src/interfaces/trip-dispatch.contract.ts`.

Confirm and recovery reads return `{tripId,requestId,kind:"DISPATCH",status,stage,
payloadHash,version,result,error,nextRetryAt,results}`. PENDING returns HTTP 202;
REJECTED and COMPLETED return 200. Stages are ACCEPTED, SUBMITTED, RECEIPTED,
COMPLETED or REJECTED. Detail exposes `dispatchOperation:{requestId,status,stage}`
or null for refresh recovery. Keep the exact body/requestId across retries;
another actor or changed body cannot reuse it.

The existing TripDispatch is the sole orchestration record. It persists the
whole set and stable child keys before owner calls, and the complete Fulfillment
receipt before atomically committing IN_PROGRESS and TripDispatched v2 outbox.
No DISPATCH TripOperation or separate resource lease is created. PENDING and
granted work block cancellation/reopen; after submission, unknown outcomes
recover forward rather than release resources or request replacement grants.
COMPLETED does not mean Inventory ISSUE has finished. Only ShipmentDispatched
triggers ISSUE; TripDispatched must not create a second stock movement.

Deploy the additive `20261025162543_phase4_durable_dispatch` migration together
with compatible Order, Fulfillment, Master Data and messaging contracts. Existing
legacy PENDING rows without an immutable batch remain fail-closed with
`DISPATCH_LEGACY_INTENT_REQUIRES_RECONCILIATION`; inspect owner receipts and
history instead of editing state, deleting intents or fabricating grants.
The existing recovery worker retries persisted work with bounded backoff.

`node scripts/test-trip-integration.mjs --phase4` runs the permanent real Gateway,
owner PostgreSQL and Kafka regression suite on owned isolated infrastructure and
removes its containers afterward. It never deploys migrations to a shared DB.
This backend proof does not claim browser acceptance or centralized
Audit/Notification consumption.

Public routes use `/api/v1`, a verified user JWT, and the corresponding
`transport:trip:read`, `transport:trip:create`, or `transport:trip:update`
permission:

| Method and path | Purpose |
|---|---|
| `GET /trips` | Filtered, paginated trip list |
| `POST /trips` | Create a DRAFT with immutable warehouse/depot snapshot |
| `GET /trips/eligible-shipments` | READY_TO_SHIP pool by warehouse and page, including optional `shipmentNumber` for display |
| `GET /trips/:tripId` | Trip, current/historical membership, stop snapshots |
| `PATCH /trips/:tripId` | Update fields on a draft |
| `POST /trips/:tripId/assignment` | Assign or clear vehicle and Driver references |
| `POST /trips/:tripId/shipments` | Begin a durable batch claim |
| `POST /trips/:tripId/shipments/remove` | Begin durable membership releases |
| `GET /trips/:tripId/operations/:requestId` | Read/retry a stored operation |
| `POST /trips/:tripId/cancel-preview` | Signed five-minute cancellation preview |
| `POST /trips/:tripId/cancel` | Confirm cancellation and release memberships |

Commands use UUID `requestId` plus a trip `expectedVersion` (membership
commands use `expectedTripVersion`). Exact actor+payload replays return their
original result before stale-version checks. A changed actor or payload with
the same request ID conflicts. Membership/cancellation endpoints return a durable operation view.

Display labels use saved shipment numbers and frozen vehicle/Driver snapshots;
UUID references remain API identifiers, not end-user names. The pool display
field is supplied by Fulfillment through the shared contract, without additional
Master Data lookups or changes to eligibility, pagination or claiming rules.

### Phase 3 route planning and approval

The exact public DTOs and response schemas are exported from
`@logix/messaging` (`interfaces/trip-route.contract.ts`). All paths below are
relative to `/api/v1/trips/:tripId`:

| Method and suffix | Permission | Response |
|---|---|---|
| `GET /route-plans` | `transport:route:read` | `{items: RoutePlanView[]}` |
| `GET /route-plans/:planId` | `transport:route:read` | `RoutePlanView` |
| `POST /route-plans/manual` | `transport:route:approve` | 201 `RoutePlanView` |
| `POST /route-optimizations` | `transport:route:optimize` | 201 `RoutePlanView` |
| `POST /route-approval-preview` | `transport:route:approve` | Signed preview |
| `POST /approve-route` | `transport:route:approve` | 200 trip detail |
| `POST /override-route` | `transport:route:approve` | 200 trip detail |
| `POST /reopen` | `transport:trip:update` | 200 trip detail |

Manual creation requires `{requestId,expectedTripVersion,orderedStopIds}`;
optimization requires `{requestId,expectedTripVersion}`. The manifest must be a
complete permutation of active stops. Decimal weight (3 places) and volume
(6 places) are checked against real positive capacity; exact equality is allowed.
Warehouse/vehicle ACTIVE state, Driver profile and current Identity eligibility,
and authoritative Fulfillment claim/current READY_TO_SHIP state are checked
through owning APIs. Coordinates, depot, measures and resource data never use
sample/default fallbacks.

Preview requires `{expectedVersion,planId,planVersion,inputHash}`. Override
preview additionally requires both `orderedStopIds` and nonblank `reason`.
Confirmation sends the same selection plus `{requestId,previewToken,confirmed:true}`
to the matching approve/override endpoint. Tokens expire after 300 seconds and
bind issuer/audience/purpose, tenant, actor, trip/version, plan/version/hash,
action and override order/reason. They cannot be exchanged with cancellation,
user or service-authentication tokens. A committed approval's identical
actor+payload retry returns its stored receipt **before** expiry/state checks;
altered actor/payload fails. Do not refresh the token silently during confirmation.

Every approval creates a new immutable route version and stores snapshots and
approval evidence on that version. The proposal is not overwritten. Override
versions link their original and store their reason; unmeasured metrics/ETA/
distance/cost remain `null`, not synthetic zeroes. Stop sequences are cleared
before resequencing to respect immediate uniqueness constraints.
Public `totalDistance`/`legDistance` are decimal metres; optimizer metrics named
`*_km` remain kilometres. `legDurationSeconds` is seconds, total weight is kg
and volume is cubic metres. Do not infer a missing value from a different unit.

Trip updates and approval are serialized on the tenant trip row. Existing
`ux_trips_vehicle_active` and `ux_trips_driver_active` partial unique indexes
reserve resources for APPROVED/IN_PROGRESS across all dates, including
soft-deleted rows. DRAFT has no reservation. There is no lease table. Reopen
requires `{requestId,expectedVersion,reason}`, clears the selected plan pointer
and current approved sequences, and retains historic plans/snapshots. It is a
local optimistic command: an old-version repeat conflicts, not a new workflow.

An approved route and `RouteApproved` v2 outbox event commit atomically. The
Transport relay uses locked, ordered, bounded batches; broker failure schedules
retry, while ACK-before-mark failure replays the **same eventId**. Consumers
must deduplicate. `ShipmentCanceled` invalidates APPROVED→DRAFT and releases
local resources before recovering its existing upstream release operation;
historic approval evidence remains. IN_PROGRESS or non-rejected dispatch
evidence fails closed without consuming Inbox or freeing resources.

Configure `ROUTE_OPTIMIZER_SERVICE_URL`, `ROUTE_OPTIMIZER_TIMEOUT_MS`,
`KAFKA_TRANSPORT_TOPIC`, and existing `OUTBOX_*` settings. The optimizer requires
the same configured internal service secret and its own migrated database.
Approval uses the existing dedicated preview-secret domain with distinct
issuer/audience/purpose; never configure it equal to JWT authentication secrets.

The optimizer request shell is persisted on the existing RoutePlan before HTTP.
It is not visible/selectable until a validated complete result is saved. An
unavailable/invalid/stale result cannot become a route proposal. Failure
diagnostics are sanitized in `optimizerResponse`; retry the **original requestId
and expectedTripVersion** to recover a lost committed optimizer response.
Changed input needs a new request. No per-action workflow or lease table exists.

Run real isolated Phase 3 proof from the backend root (requires the existing
cached PostgreSQL/Kafka images and a Python environment with declared optimizer
`[test,optimization]` and Agent `[test]` dependencies):

```powershell
$env:ROUTE_OPTIMIZER_TEST_PYTHON = (Resolve-Path .phase3-python\Scripts\python.exe).Path
node scripts\test-trip-integration.mjs --phase3
node apps\transport-service\scripts\test-migration-upgrade.mjs
```

The runner migrates only its owned database, starts actual Gateway/Transport/
Master Data/Identity/Fulfillment/optimizer APIs and Kafka, and cleans only owned
resources. Tests cover API/resource races, capacity boundaries, real persisted
optimizer retries/restarts, approval replay, history, cancellation invalidation
and broker ACK/database-mark rollback. They also run the actual Agent Python
route adapters against Gateway without an LLM or Agent database.
`DOTENV_CONFIG_PATH` points at a deliberately nonexistent project-local file;
the shared configuration module honors it without reading service environment
files. An optional
`PHASE3_RUNTIME_CONTRACT_OUTPUT` path writes sanitized actual wire responses,
replacing the opaque preview token with a noncredential sentinel.

### Phase 5 Driver delivery and result projection

Public Driver endpoints are prefixed by `/api/v1/driver/trips` and use the
existing user JWT and tenant context:

| Method and path | Permission | Contract |
|---|---|---|
| `GET /driver/trips` | `transport:driver:read` | `scope=current\|history`, pagination; `driverId` filter is Super Admin only and tenant-scoped. |
| `GET /driver/trips/:tripId` | `transport:driver:read` | Trip, frozen vehicle/Driver/depot and contact snapshots, approved stop order and next stop. |
| `POST /driver/trips/:tripId/stops/:stopId/action-preview` | `transport:driver:update` | Super Admin only; signed preview bound to actor, tenant, assignee, action, versions and reasons. |
| `POST /driver/trips/:tripId/stops/:stopId/deliver` | `transport:driver:update` | Terminal DELIVERED command/receipt. |
| `POST /driver/trips/:tripId/stops/:stopId/fail` | `transport:driver:update` | Terminal FAILED command/receipt; requires a distinct failure reason. |

List query defaults: `scope=current`, `page=1`, `pageSize=20` (maximum 100).
Current includes `IN_PROGRESS`; history includes `COMPLETED` and `CANCELED`.
Driver access binds to the authenticated `driverUserId`; Super Admin may read
or act without a Driver profile, but only within the authenticated target
tenant. Actions still require the current trip/stop versions and the next
approved-sequence `PENDING` stop on an `IN_PROGRESS` trip. Drivers send
`{requestId,expectedTripVersion,expectedStopVersion,confirmed:true}` plus
failure `reason` when applicable. Super Admin commands additionally repeat the
signed `previewToken` and `actingReason`; these fields never impersonate the
assigned Driver. No arrive, force-complete or redelivery endpoint exists.

`DeliveryAttempt` is one immutable terminal receipt per stop/request, not an
independent retry lifecycle. It records actual actor separately from assignee.
Exact committed replay is checked before current-state/preview-expiry
validation; a changed actor or payload conflicts. After unknown HTTP outcome,
retry only the exact original endpoint/body/request ID in the original
tenant/user context. The final terminal result completes the trip and releases
resource exclusivity inside the same transaction.

The Transport Outbox publishes strict Delivery Result v2 under
`DeliveryTrip`; the event payload binds tenant/trip/stop/shipment/attempt,
Driver/assignee, outcome, occurrence time, reason and request ID. Actual
`actorId` is envelope metadata. Fulfillment validates the canonical schema and
trip/shipment binding, durably defers a result that arrives before shipment
dispatch projection, applies semantic dedupe/conflict protection, and commits
Shipment terminal status/history/Outbox together. Order projection continues
from Shipment lifecycle; delivery-result handling does not alter Inventory or
issue another stock movement.

Transport migration `20261026222454_phase5_driver_terminal_receipts` adds the
terminal receipt persistence and constraints. Create/apply with Prisma migrate
only; **never run `prisma db push`**. Phase evidence includes Transport API
integration on isolated PostgreSQL (16/16), Fulfillment Kafka/PostgreSQL
delivery-result E2E (2/2), and owner package regressions. These are layered
integration suites, not one end-to-end runtime journey from `CONFIRMED`
through every service to Order projection. No browser, live FE-to-Gateway,
centralized Audit ingestion or production deployment is claimed.

### Historical migration upgrade verification

Run `pnpm --filter transport-service test:migrations:upgrade` from the backend root.
It requires Docker and the cached `postgres:17-bookworm` image, starts its own
PostgreSQL container, deploys the four Phase 1 migrations, seeds legacy trip,
membership, stop, and pending-operation data, then deploys the Phase 2 and
simplification/lifecycle migrations through Prisma. It checks safe demand
backfill, remove/re-add history, pending-operation retention, removal of legacy
preview/status fields, PLANNED→DRAFT and ARRIVED→PENDING preservation, approval
evidence and arrivedAt/currentAttempt retention, terminal attempt constraints,
resource uniqueness, and fail-closed handling of unsafe dispatch and
REJECTED/SUPERSEDED route evidence. The lifecycle migration refuses to drop
RoutePlan status while REJECTED/SUPERSEDED rows remain; the owning Audit service
must preserve those actual decisions and an approved rollout cleanup must
resolve the source rows before retrying. The migration does not fabricate audit
records or add a legacy workflow flag. The runner removes its owned container
and project-local staging directory on completion. No shared database, schema
DDL outside migration deploy, or `db push` is used.

Assignment actions return HTTP 200 with the trip detail. Membership commands return a
durable operation view; pending is HTTP 202, completed is HTTP 200. A definitively
rejected add command returns HTTP 409 after durable compensation; its operation
query returns HTTP 200 with `status: REJECTED`. Active shipment uniqueness,
request replay mismatch, and same-trip pending mutation conflicts return HTTP 409
with the platform `BUSINESS_RULE_VIOLATION` code. Unknown
downstream results remain pending and are retried by a bounded worker or the
operation query route. A timeout never frees the shipment back into the pool.

Fulfillment is called through its signed internal APIs using exact
`@logix/messaging` claim/release request and receipt schemas. Pool exclusion
IDs are sent as repeated query parameters and applied before authoritative
count/page. No database transaction spans HTTP. Both delivery coordinates are
required for new membership and must be valid decimal strings within geographic
bounds. Missing or invalid snapshot coordinates cause a definite rejection:
any successful upstream claim is durably released before clearing membership.
Claim address, coordinates,
and decimal demand are copied into immutable membership and a stable stop.
Removal soft-deletes the active stop; re-add uses that stop identity. BigInt
versions are exposed only after safe-integer validation, and measurements are
decimal strings.

Before writing any Driver reference, Transport reads the ACTIVE profile via
Master Data's public API and calls signed
`POST /api/v1/internal/drivers/:id/link-lock` with `{ version, expectedUserId }`.
The token uses `transport-service` issuer, `master-data-service` audience and
the assignment tenant. The returned Driver/user/version binding is stored.
The lock is permanent even if insertion fails, the trip is canceled, or the
reference is removed; never unlock or infer failure from timeout. Warehouse,
Vehicle and Driver must be ACTIVE. Depot snapshot is frozen at trip creation;
Vehicle/Driver approval snapshots remain null during Phase 2.

`ShipmentCanceled` is consumed from the configured Fulfillment Kafka topic
using envelope/payload validation, event Inbox deduplication, and aggregate
version checks. Manifest effects, stop visibility, route validity and decimal
totals update atomically before durable release recovery. Malformed events fail
the handler without an Inbox marker.

Cancellation preview returns `previewToken`, a signed HS256 JWT bound to purpose,
tenant, actor, trip, expected version, and the active membership hash. It expires
after 300 seconds. Confirmation re-reads the trip and memberships in a transaction;
the token does not reserve the trip or bypass pending-operation/version checks.
An exact stored CANCEL receipt is replayed before token expiry checks, including
after expiry. During migration, the backend accepts the legacy `previewId` body
only to look up and replay an exact existing CANCEL receipt. Without that receipt,
it returns HTTP 422 with `CANCEL_PREVIEW_REFRESH_REQUIRED`; it never reads the
retired preview table. New requests must use `previewToken`.

Schedule and vehicle-only draft edits use tenant-scoped optimistic compare-and-set
and do not create TripOperation rows. Clearing a Driver (`driverId: null`) is
also local; providing a Driver ID uses the durable assignment path, including
mixed schedule/vehicle payloads, because it permanently locks Driver identity.
After an ambiguous local-edit response, clients must read the trip and show its
actual state; a stale-version retry is not guaranteed to replay.

Required configuration is shown in [.env.example](.env.example).
`INTERNAL_SERVICE_JWT_SECRET` must match downstream services; user-token
verification uses `JWT_SECRET`. `TRIP_CANCEL_PREVIEW_SECRET` is a dedicated
random key of at least 32 characters and must differ from both other JWT secrets;
missing or reused keys fail startup. `RECOVERY_INTERVAL_MS` defaults to 5000 and
is bounded between 1000 and 60000 ms.

Run `pnpm --filter transport-service test`, `lint`, and `build` from the backend
root. Real cross-service API/Kafka integration is
`pnpm --filter transport-service test:trips:integration`; the parent task owns
the isolated-resource integration runner.

[Nest](https://github.com/nestjs/nest) framework TypeScript starter repository.

## Project setup

```bash
$ pnpm install
```

## Compile and run the project

```bash
# development
$ pnpm run start

# watch mode
$ pnpm run start:dev

# production mode
$ pnpm run start:prod
```

## Run tests

```bash
# unit tests
$ pnpm run test

# e2e tests
$ pnpm run test:e2e

# test coverage
$ pnpm run test:cov
```

## Deployment

When you're ready to deploy your NestJS application to production, there are some key steps you can take to ensure it runs as efficiently as possible. Check out the [deployment documentation](https://docs.nestjs.com/deployment) for more information.

If you are looking for a cloud-based platform to deploy your NestJS application, check out [Mau](https://mau.nestjs.com), our official platform for deploying NestJS applications on AWS. Mau makes deployment straightforward and fast, requiring just a few simple steps:

```bash
$ pnpm install -g @nestjs/mau
$ mau deploy
```

With Mau, you can deploy your application in just a few clicks, allowing you to focus on building features rather than managing infrastructure.

## Observability

In production applications, observability is essential for understanding how your system behaves, detecting issues early, and maintaining reliable performance.

[NestJS Observe](https://observe.nestjs.com) automatically instruments your NestJS application, giving you deep visibility into your system with minimal setup:

- **Distributed tracing:** Follow requests across services and understand how they flow through your system.
- **Waterfall analysis:** Visualize request execution and identify slow operations, bottlenecks, and unexpected delays.
- **Performance analysis:** Analyze application performance in real time and quickly pinpoint areas that need optimization.
- **Metrics:** Track key application and infrastructure metrics to understand system health and performance trends.
- **Logging:** Centralize and correlate logs with traces and other telemetry to make debugging easier.
- **Error tracking:** Detect errors quickly and investigate their root causes with the surrounding context.
- **SLA monitoring:** Track service-level objectives and identify when your application is approaching or exceeding defined thresholds.
- **Alarms and alerts:** Set up alerts for critical errors, performance degradation, SLA violations, and other anomalies so your team can react quickly.

## Resources

Check out a few resources that may come in handy when working with NestJS:

- Visit the [NestJS Documentation](https://docs.nestjs.com) to learn more about the framework.
- For questions and support, please visit our [Discord channel](https://discord.gg/G7Qnnhy).
- To dive deeper and get more hands-on experience, check out our official video [courses](https://courses.nestjs.com/).
- Deploy your application to AWS with the help of [NestJS Mau](https://mau.nestjs.com) in just a few clicks.
- Auto-instrument your application with [NestJS Observer](https://observer.nestjs.com). Distributed tracing, metrics, and logging made easy. Error tracking and performance monitoring for your NestJS applications.
- Visualize your application graph and interact with the NestJS application in real-time using [NestJS Devtools](https://devtools.nestjs.com).
- Need help with your project (part-time to full-time)? Check out our official [enterprise support](https://enterprise.nestjs.com).
- To stay in the loop and get updates, follow us on [X](https://x.com/nestframework) and [LinkedIn](https://linkedin.com/company/nestjs).
- Looking for a job, or have a job to offer? Check out our official [Jobs board](https://jobs.nestjs.com).

## Support

Nest is an MIT-licensed open source project. It can grow thanks to the sponsors and support by the amazing backers. If you'd like to join them, please [read more here](https://docs.nestjs.com/support).

## Stay in touch

- Author - [Kamil Myśliwiec](https://twitter.com/kammysliwiec)
- Website - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)

## License

Nest is [MIT licensed](https://github.com/nestjs/nest/blob/master/LICENSE).
