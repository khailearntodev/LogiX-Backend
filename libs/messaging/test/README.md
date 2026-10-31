# Isolated Kafka foundation

Existing messaging unit tests mock Kafka/relay stores; they do not provide an
isolated real broker. `support/isolated-kafka.ts` now owns a single disposable
KRaft broker, loopback port, UUID client/topic/group and container cleanup.
It uses the existing KafkaJS/Vitest dependencies. Docker must be responsive and
`apache/kafka:4.1.1` already cached (`TEST_KAFKA_IMAGE` may select another cached
compatible Apache image). `--pull=never` prevents downloads. It never uses the
shared application broker, credentials, topics or consumer groups.

From the backend repository root in PowerShell:

```powershell
pnpm --filter @logix/messaging test:integration
```

Normal `pnpm --filter @logix/messaging test` selects only `src/**/*.spec.ts`
through `vitest.config.ts` and requires no Kafka. The explicit integration
script selects the real roundtrip through `vitest.config.integration.ts`.
Missing Docker/image fails that run: no skipped-success or mock fallback is
counted as integration proof. The helper polls a real
Kafka metadata call for readiness and removes only its returned container ID
on failure/teardown. If the process is forcibly interrupted, remove only the
specific `logix-messaging-test-<UUID>` container from that invocation.

The roundtrip proves topic creation, broker publish/consume, aggregate key and
version-1 envelope/identity preservation. It does not prove production Transport
event handlers, version-2 rollout (the existing generic consumer accepts v1
only), persisted outbox/Inbox, redelivery deduplication, result defer, ordering
under failure, broker restart, or cross-service convergence. Those require the
owning next-phase runtime implementations and isolated service database tests.
