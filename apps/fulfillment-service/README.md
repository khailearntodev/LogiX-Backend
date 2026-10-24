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

## Shipment Pool (phase 5B)

This service owns one shipment per Order and immutable shipment snapshots.
The approved lifecycle is PENDING_PICK -> PICKING -> READY_TO_SHIP ->
DISPATCHED -> DELIVERED/FAILED; cancellation is driven by Order events.
Trip/route/POD/redelivery are not part of this API.

Configure every key in [.env.example](.env.example). JWT_SECRET must match
Identity; INTERNAL_SERVICE_JWT_SECRET must match Order/Inventory. All three
business services must share KAFKA_FULFILLMENT_TOPIC; Gateway additionally
requires FULFILLMENT_SERVICE_URL. There are no default secrets or downstream
URLs. Restart all affected services after configuring them.

From the repository root:

```sh
pnpm install
pnpm --filter @logix/messaging build
pnpm --filter fulfillment-service db:migrate:dev
pnpm --filter fulfillment-service db:generate
pnpm --filter fulfillment-service test
pnpm --filter fulfillment-service build
pnpm --filter fulfillment-service start
```

The lifecycle migration requires an empty legacy shipment pool and deliberately
fails otherwise; obtain verified Order snapshots and an approved state backfill
before migrating a deployment with legacy rows. Never reset a business DB.
Consumers read historical Order events; this can create pool entries for
previously confirmed orders but does not change stock.

Public endpoints through Gateway (`/api/v1` prefix):

| Method/path | Permission | Body |
| --- | --- | --- |
| GET /shipments | fulfillment:shipment:read | Query: page/pageSize, warehouseId, orderId, status **or** statuses, createdFrom/createdTo |
| GET /shipments/:id | fulfillment:shipment:read | None |
| POST /shipments/:id/start-picking | fulfillment:shipment:update | version |
| POST /shipments/:id/mark-ready | fulfillment:shipment:update | version |
| GET /shipments/:id/dispatch-preview | fulfillment:shipment:read | None |
| POST /shipments/:id/dispatch | fulfillment:shipment:dispatch | version, orderVersion, requestId (UUID), confirmed: true |
| POST /shipments/:id/mark-delivered | fulfillment:shipment:complete | version, confirmed: true |
| POST /shipments/:id/mark-failed | fulfillment:shipment:complete | version, confirmed: true, nonblank reason |

### Shipment list filters

`GET /api/v1/shipments` returns `{ items, total, page, pageSize }` unchanged.
All filters are applied on the server before pagination, including tenant and
soft-delete scope. Items and total use the same predicate. Sorting remains
`createdAt DESC, id DESC`.

| Query | Contract |
| --- | --- |
| `status` | Existing single shared shipment status; omission preserves all-status behavior |
| `statuses` | Additive scalar CSV, e.g. `PENDING_PICK,PICKING` for preparation; a single token is also valid |
| `page` / `pageSize` | Positive integers; default 1 / 20, pageSize max 100, page max 21474836 |
| `warehouseId` / `orderId` | Optional UUID filters, combined with status/date filters |
| `createdFrom` / `createdTo` | Optional strict ISO 8601 dates/timestamps, inclusive; reversed range returns 400 |

`status` and `statuses` are mutually exclusive. Empty CSV, empty tokens,
unknown/case-mismatched statuses, duplicate tokens, surrounding token whitespace,
or repeated query keys producing an array return 400; no tokens are silently
trimmed, removed or deduplicated. For the ready pool, use
`status=READY_TO_SHIP`; canceled/dispatched rows are excluded by that predicate.
Invalid query input uses the existing HTTP 400 contract, not a new business
error reason.

Examples (relative to the configured Gateway):

```text
/api/v1/shipments?statuses=PENDING_PICK,PICKING&page=1&pageSize=20
/api/v1/shipments?status=READY_TO_SHIP
/api/v1/shipments?page=2
```

Database/Gateway integration proof uses the existing Vitest e2e runner:

```text
pnpm --filter fulfillment-service test:e2e test/pick-pack.query.e2e-spec.ts
```

Explicitly set `PICK_PACK_QUERY_E2E=1` and `PICK_PACK_GATEWAY_URL` to the approved
QA Gateway URL. The suite reads Fulfillment `DATABASE_URL`/`JWT_SECRET` from the
service-local environment, requires a deployed current API, inserts only tagged
Shipment fixtures for two fresh UUID tenant contexts, and removes only its
recorded UUIDs with a post-cleanup count assertion. It signs narrow-permission
test JWTs using the existing local signing configuration; do not run on
production or without fixture authorization. No Identity users, reservations,
history or outbox events are created. This proves PostgreSQL list semantics,
Gateway routing and real JWT/permission guards, **not** Identity login or Order
confirmation/event delivery. With no opt-in the suite is skipped, not passed.
Keep this permanent regression suite; it is not a disposable test script.

Alternatively, run this same query suite with `PICK_PACK_STACK_E2E=1` and
the isolated-stack prerequisites/variables below (build all four services
first). In that mode no `PICK_PACK_GATEWAY_URL` is needed: the suite explicitly
creates and cleans its own Gateway/services/PostgreSQL/Kafka resources rather
than falling back to shared instances. The query matrix includes the Phase 4
frontend's all/preparation/picking/ready query shapes, page size 20, and combined
warehouse/order/local-day filters. It proves server filtering, not browser tab
or router interaction.

No schema change is required for this query extension. If a later change needs
one, create reviewed SQL with `prisma migrate dev` (or `--create-only`), never
`prisma db push`; never reset a business database.

### Pick/pack transaction and cancellation regression

Pick/ready keep their existing version-only bodies; neither requires dispatch
preview, requestId, or a new `confirmed` field. Invalid versions return 400;
stale versions return 409 / `SHIPMENT_VERSION_CONFLICT`. Invalid transitions
and pending dispatch return their existing reasons. A committed transition
increments version and writes one history/outbox atomically; ready also sets
`readyAt`. Picking/packing never changes inventory quantities.

The frontend Pick List uses `items` and `warehouseSnapshot` from the existing
detail response, including decimal-string quantities and per-line snapshots;
it does not read current Inventory availability or save line-level progress.
After a command it reads detail again before publishing success. A stale
version, uncertain response or failed follow-up read requires an explicit
successful reload before further pick/pack commands; it never retries those
POSTs automatically. Dispatch retains its existing same-request recovery
contract. The lifecycle suite includes a multi-line pick list with a
100-character SKU, fractional quantity, authoritative reads after both commands
and movement between preparation/ready queries. These are API/data proofs,
not browser rendering or dialog tests.

The permanent suites below exercise **real Gateway, Order, Inventory,
Fulfillment, PostgreSQL and Kafka**, independently of AI or Transport:

```text
pnpm --filter fulfillment-service --filter order-service --filter inventory-service --filter api-gateway build
pnpm --filter fulfillment-service test:e2e test/pick-pack.query.e2e-spec.ts test/pick-pack.lifecycle.e2e-spec.ts test/pick-pack.cancellation.e2e-spec.ts --no-file-parallelism
```

Before the second command, explicitly set:

| Variable | Requirement |
| --- | --- |
| `PICK_PACK_STACK_E2E` | `1`, only after authorizing temporary infrastructure and fixture cleanup |
| `PICK_PACK_TEST_HOST` | `127.0.0.1`; client URLs use allocated ports on loopback, Docker publishes the test DB on loopback |
| `PICK_PACK_POSTGRES_IMAGE` | An existing local PostgreSQL image approved for QA; the suite does not pull images |

Docker daemon and the service-local configured Kafka broker must be available.
The helper reads required settings from local service environments, overrides
all three business service database URLs to a **new disposable PostgreSQL
container**, and allocates fresh `qa.pickpack.<UUID>` Kafka topics/groups.
It applies only committed migrations with `db:migrate:deploy`, using each
service's schema search-path (`orders`, `inventory`, `fulfillment`). It does
not run `db push`, reset a database, or generate migrations.

Each suite starts separate compiled service/Gateway processes. Order DRAFT
and stock fixtures are seeded directly into their owning test schemas; confirm,
pick, ready and cancel then run through real HTTP. Narrow-permission JWTs use
random per-suite secrets, not the shared deployment signing key. This proves
service JWT/RBAC boundaries, **not Identity login, Master Data validation at
order creation, or full procurement/receiving**. Kafka replay cases include
synthetic source envelopes and corresponding isolated reservation fixtures.
Compiled Order/Inventory database clients are used only for test setup/read-back;
no production service queries another service's database.
Nest services retain their native listen configuration; using loopback client
URLs is not a claim that their HTTP listeners bind only to loopback.

Rollback injection uses temporary PostgreSQL triggers only in that disposable
database. Release-unavailable recovery stops/restarts only that suite's
Inventory process; the inconsistent-reserved case mutates and restores only
its deliberate test fixture. Never reproduce these faults on shared data.
The helper uses IPC to request native Nest shutdown hooks (including Kafka
LeaveGroup) before deleting its exact consumer groups/topics and container.
Cleanup failures fail the suite. Container/topics names are printed as ownership
evidence; no secrets or connection strings should be logged.

Assertions cover concurrent same-version requests, history/outbox rollback,
immutable snapshots/items, exact decimal quantities, unchanged stock while
pick/ready, ordered lifecycle projection, duplicate/stale/cancel-before-confirm
events, one-time release at each pre-dispatch stage, persisted cancellation
intent/recovery, cancellation races and irrevocable dispatch grants.
Downstream regression also exercises dispatch preview, unchanged request replay,
exactly one Inventory ISSUE, removal from the ready query, delivered/failed
confirmation and Order completion projection. Completion does not issue stock
again. The final isolated run passed 46 query, 16 lifecycle and 11 cancellation
cases; these counts do not include unit tests.
They do not simulate arbitrary future event reordering or production broker
failure/load, and they are not browser tests. Without explicit opt-in the
suites are skipped, not passed. Keep the helper and suites as regression assets.

The four permissions are seeded as catalogue entries only, without assigning
custom roles. Existing OWNER/SuperAdmin authorization policy is unchanged.

Dispatch preview returns the shipment and Order versions. Wait for Order's
READY projection before preview. Submit a stable requestId and retain the exact
body for retries. A timeout/503 can mean Order has already granted dispatch:
the pending intent remains visible in list/detail and the recovery worker
retries it with bounded persisted backoff, including after restart. Do not
create a replacement request while an intent is PENDING. No transaction spans
the grant HTTP request. A successful dispatch does not mean Inventory has
already consumed ISSUE; Inventory and Order converge through Kafka.

Frontend pool/detail, themed confirmations and pending-state UX are implemented
in phase 5C under `LogiX-Frontend/src/features/shipments`. Order list/detail now
also expose nullable `dispatchGrantedAt`/`dispatchShipmentId`; deploy the updated
Order API with the frontend so cancellation remains blocked during projection
lag. Local ignored env files were synchronized in 5C; restart affected services
to load the new values. No browser acceptance or phase-5D load acceptance is
claimed (browser checks were explicitly excluded by the user for this batch).

### Pick-and-pack release and recovery

Deploy the backward-compatible Fulfillment query API before the frontend that
uses `statuses`. On rollback, roll back that frontend first, then the query API.
This feature adds no schema migration, so there is no database rollback step.
Any future schema change must use reviewed Prisma Migrate SQL, never `db push`.

Do not undo committed business actions by editing versions, history, events or
stock balances. Read authoritative detail after an uncertain pick/pack response
and continue only with the current permitted state/version. Retry cancellation
through Order's persisted recovery flow. For uncertain dispatch, retain the same
requestId and payload; do not replace a pending intent. A ready shipment is not
yet issued stock, and neither packing nor shipment completion creates a trip or
requests route optimization.

## Description

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
