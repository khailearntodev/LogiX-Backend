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

### Driver master data

`/api/v1/drivers` now supports list/detail/create/update and versioned
enable/disable through the Gateway. `master-data:driver:read` authorizes reads;
`master-data:driver:manage` authorizes writes and `/drivers/eligible-users`.
Every query/write uses the verified access-token tenant. Code and user linkage
are immutable in ordinary updates. Conflicting code, user or license and stale
versions return conflicts; no hard deletion endpoint is provided.

Identity owns names/membership/permissions. The authenticated internal lookup
requires active tenant membership and both assigned-Driver permissions (or
effective OWNER/wildcard/Super Admin membership) before create/enable. Historical
names for existing profiles are still resolved from Identity when a user is
disabled. An Identity outage is an explicit error, not a fabricated name or empty
success.

Configure the required variables in [.env.example](.env.example).
`IDENTITY_SERVICE_URL` is the service origin, not an `/api/v1` URL; the adapter
appends that API prefix. The internal signing secret must match Identity's and
must contain at least 32 characters. `TRANSPORT_SERVICE_URL` is also required
and is an origin; its internal signing secret must match this service. No secret
defaults or "assume unused" switch are supplied.

#### Correcting a mistaken user link

Both endpoints require the existing `master-data:driver:manage` effective
permission and verified tenant:

- `POST /api/v1/drivers/:id/relink-user/preview`
- `POST /api/v1/drivers/:id/relink-user`

Both accept exactly `{ version, expectedUserId, userId, reason }`; UUID bindings,
safe positive integer version, and trimmed nonblank reason (max 1000 characters)
are mandatory. Preview returns
`{ driverId, version, previousUserId, userId, previousDisplayName, displayName, reason }`.
The UI must show old -> new plus reason, then explicitly confirm with the same
frozen body. Preview is read/validation-only, not a token or reservation; apply
repeats every check and returns the ordinary Driver view with incremented version.
An optional UUID `x-correlation-id` is retained in the audit evidence.

The target must already be an eligible member; nothing grants permissions.
Code, license, phone, status and historical trip data remain unchanged. No-op,
stale/changed-old binding, duplicate tenant+user (including deleted profiles),
cross-tenant/ineligible targets, and any draft/canceled/completed/deleted trip
reference reject. `DRIVER_LINK_LOCKED` (409, details.reason=`USED`) and
`DRIVER_LINK_UNCHANGED` (409) are top-level error codes; stale bindings use
`CONCURRENCY_CONFLICT`, other uniqueness conflicts use `CONFLICT`.
Super Admin cannot bypass the tenant, lock, usage, or version rules. Missing or
unavailable Transport/Identity fails closed without changing Driver or outbox.

`POST /api/v1/internal/drivers/:id/link-lock` is **not Gateway exposed**.
It requires the signed allowlisted Transport caller, tenant/audience binding,
and `{ version, expectedUserId }`. It atomically checks that binding, permanently
sets `linkLockedAt`, and returns `{ driverId, userId, version }`. Repeating the
same binding after a timeout is safe and returns the same current binding;
versions are not incremented for lock-only metadata. A concurrent profile update
can make the retry stale: caller must reread/revalidate, never assume the lock
failed or clear it. The returned version/user is authoritative for assignment.

**Rollout prerequisite:** fence all legacy trip writers; every future Transport
draft/create/reassignment/import must successfully lock the expected binding
before persisting a reference, and use the returned binding. Release/cancel/failure
never clears a lock. No production trip mutation endpoints exist yet. Deploy
Transport history reads before enabling this relink API; the history query catches
legacy rows and never filters lifecycle/soft deletion. No DB transaction spans
cross-service HTTP. See [database design §6.6](../../docs/architecture/database-design.md#66-drivers).

The relink transaction writes the standard local `master_data.outbox_events`
record `DriverUserRelinked` v1 atomically with Driver. Its payload matches the
AuditLog field vocabulary (trusted JWT actor distinct from target, IDs, reason,
before/after versions, outcome, timestamp, source and correlation). An insert
failure rolls back both. Preview/rejections emit no success evidence. This is
durable local audit evidence, **not proof of centralized Audit ingestion**:
Audit remains scaffolded; relay/consumer wiring is not implemented by this change.

Run `pnpm --filter master-data-service test:drivers:integration` from the backend
root for real Gateway/Identity/Transport/PostgreSQL checks. See [test setup](test/README.md).
The mistaken-link addition has a Prisma-generated lock/outbox migration;
Transport has a historical driver-reference index migration. All are deployed
and checked in an isolated database. Future schema changes must use Prisma
migrate, never `db push`.

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
