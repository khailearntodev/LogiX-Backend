# Driver API integration tests

The committed `drivers.e2e-spec.ts` exercises the actual Gateway routing, Driver
controllers, Passport JWT/permissions, internal signed Identity/Transport HTTP
lookups and three real Prisma clients. `driver-relink.e2e-spec.ts` additionally
checks preview/apply, actor-vs-target atomic local outbox, failed-audit rollback,
all historical trip statuses/deletion, eligibility/tenant/permissions,
competing relinks/unique user, permanent lock retries, lock-winning-after-history
and relink-winning-before-stale-lock races, and actual Transport outage.
It does not use a browser or mock database. Centralized Audit ingestion is not
claimed; the test checks the local standard outbox transaction.

For a self-contained run with the existing cached `postgres:17-bookworm` image:

```powershell
pnpm --filter master-data-service test:drivers:integration
```

The runner checks Docker readiness, starts one uniquely named container on an
ephemeral loopback port, deploys existing migrations to all three schemas, checks
migration status, runs the canonical API suites and removes only that container in
`finally`. It neither pulls images nor touches the shared LogiX containers.

Alternatively use a disposable PostgreSQL 17 database named `logix_driver_test_<unique suffix>`.
Set `DRIVER_TEST_DATABASE_URL` to that database. Apply Identity, Master Data and
Transport migrations with their `db:migrate:deploy` scripts, using that URL as
`DATABASE_URL` with `?schema=identity` / `?schema=master_data` / `?schema=transport` respectively
(the historical migrations use unqualified table names); never `db push` or
reset a shared database.

From this service run:

```powershell
pnpm exec vitest run --config vitest.config.e2e.ts test\drivers.e2e-spec.ts
```

Fixtures use unique tenant/user IDs, generated in-memory signing keys, ephemeral
HTTP ports and explicit cleanup restricted to those IDs. The original application
smoke suite is retained and now checks the real authenticated API boundary rather
than a generated Hello World endpoint absent from the service. No QA account or secret
is persisted to the repository. Kafka is not required for Driver master CRUD;
the later dispatch/event phases require their own broker proof.

The test database must be prepared by the caller. Do not point this command at
an application database. Database/container deletion belongs to the process
that created that isolated resource.
