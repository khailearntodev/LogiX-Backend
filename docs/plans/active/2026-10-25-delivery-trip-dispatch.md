# Delivery trip & dispatch execution

Date: 2026-10-25

## Status

Active — Phase 1 T001–T006 complete; G1 PASS within the approved non-browser scope. Phase 2–5 have not started. Keep this single execution record active for the next batch.

2026-10-25 follow-up: D-14 addition to T004–T006 (mistaken user-link correction) implemented and validated within the non-browser scope. Prior G1 counts below cover the original batch; extension evidence is recorded separately at the end.

## Outcome and authority

Implement the five-phase [execution artifact](../../../../delivery-trip-dispatch-implementation-phases.vi.md) and [specification](../../../../delivery-trip-dispatch-spec.vi.md). Current batch is T001–T006 only. Backend/Frontend AGENTS, WORKFLOW, architecture and API contracts remain authoritative. No browser testing by explicit request.

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
- Transport claim/grant/preview/optimizer/result schemas are concrete target contracts, not implemented trip operations. Later phases still need production locking, outbox/Inbox, recovery and cross-service convergence proof.

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
