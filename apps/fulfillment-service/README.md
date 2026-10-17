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
| GET /shipments | fulfillment:shipment:read | Query: page/pageSize, warehouseId, orderId, status, createdFrom/createdTo |
| GET /shipments/:id | fulfillment:shipment:read | None |
| POST /shipments/:id/start-picking | fulfillment:shipment:update | version |
| POST /shipments/:id/mark-ready | fulfillment:shipment:update | version |
| GET /shipments/:id/dispatch-preview | fulfillment:shipment:read | None |
| POST /shipments/:id/dispatch | fulfillment:shipment:dispatch | version, orderVersion, requestId (UUID), confirmed: true |
| POST /shipments/:id/mark-delivered | fulfillment:shipment:complete | version, confirmed: true |
| POST /shipments/:id/mark-failed | fulfillment:shipment:complete | version, confirmed: true, nonblank reason |

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
