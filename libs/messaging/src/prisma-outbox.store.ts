import type { ServiceId } from '@logix/common';
import type { OutboxRelayRecord, OutboxRelayStore } from './outbox-relay.js';

interface OutboxRow {
  id: string;
  tenantId: string;
  eventType: string;
  eventVersion: number;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: bigint;
  correlationId: string;
  causationId: string | null;
  payload: unknown;
  occurredAt: Date;
  attemptCount: number;
}

interface OutboxTx {
  $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

export interface OutboxDatabase {
  $transaction<T>(
    callback: (tx: OutboxTx) => Promise<T>,
    options: { timeout: number },
  ): Promise<T>;
}

export class PrismaOutboxStore implements OutboxRelayStore {
  constructor(
    private readonly database: OutboxDatabase,
    private readonly schema: 'orders' | 'inventory',
    private readonly producer: ServiceId,
    private readonly transactionTimeoutMs: number,
  ) {
    if (
      !['orders', 'inventory'].includes(schema) ||
      !Number.isSafeInteger(transactionTimeoutMs) ||
      transactionTimeoutMs <= 0
    ) {
      throw new Error('Invalid outbox store configuration');
    }
  }

  async withLockedBatch(
    batchSize: number,
    callback: Parameters<OutboxRelayStore['withLockedBatch']>[1],
  ): Promise<void> {
    await this.database.$transaction(
      async (tx) => {
        // Schema is a constructor-validated owner constant; all data is parameterized.
        const rows = await tx.$queryRawUnsafe<OutboxRow[]>(
          `
        SELECT event.id, event.tenant_id AS "tenantId", event.event_type AS "eventType",
          event.event_version AS "eventVersion", event.aggregate_type AS "aggregateType",
          event.aggregate_id AS "aggregateId", event.aggregate_version AS "aggregateVersion",
          event.correlation_id AS "correlationId", event.causation_id AS "causationId",
          event.payload, event.occurred_at AS "occurredAt", event.attempt_count AS "attemptCount"
        FROM ${this.schema}.outbox_events AS event
        WHERE event.published_at IS NULL AND event.next_attempt_at <= now()
          AND event.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM ${this.schema}.outbox_events AS earlier
            WHERE earlier.tenant_id = event.tenant_id
              AND earlier.aggregate_type = event.aggregate_type
              AND earlier.aggregate_id = event.aggregate_id
              AND earlier.published_at IS NULL AND earlier.deleted_at IS NULL
              AND (earlier.aggregate_version, earlier.occurred_at, earlier.id)
                < (event.aggregate_version, event.occurred_at, event.id)
          )
        ORDER BY event.occurred_at, event.id
        LIMIT $1 FOR UPDATE OF event SKIP LOCKED
      `,
          batchSize,
        );
        const records: OutboxRelayRecord[] = rows.map((row) => {
          const aggregateVersion = Number(row.aggregateVersion);
          if (!Number.isSafeInteger(aggregateVersion)) {
            throw new Error(`Outbox aggregate version is unsafe: ${row.id}`);
          }
          const actorId =
            row.payload &&
            typeof row.payload === 'object' &&
            'actorId' in row.payload &&
            typeof row.payload.actorId === 'string'
              ? row.payload.actorId
              : null;
          return {
            id: row.id,
            attemptCount: row.attemptCount,
            envelope: {
              eventId: row.id,
              eventType: row.eventType,
              eventVersion: row.eventVersion,
              occurredAt: row.occurredAt.toISOString(),
              producer: this.producer,
              tenantId: row.tenantId,
              actorId,
              correlationId: row.correlationId,
              causationId: row.causationId ?? row.correlationId,
              aggregateType: row.aggregateType,
              aggregateId: row.aggregateId,
              aggregateVersion,
              payload: row.payload,
            },
          };
        });
        await callback(records, {
          markPublished: async (id, publishedAt) => {
            await tx.$executeRawUnsafe(
              `
            UPDATE ${this.schema}.outbox_events
            SET published_at = $2, last_error = NULL, updated_at = now(), version = version + 1
            WHERE id = $1::uuid
          `,
              id,
              publishedAt,
            );
          },
          markFailed: async (id, attemptCount, nextAttemptAt, error) => {
            await tx.$executeRawUnsafe(
              `
            UPDATE ${this.schema}.outbox_events
            SET attempt_count = $2, next_attempt_at = $3, last_error = $4,
              updated_at = now(), version = version + 1
            WHERE id = $1::uuid
          `,
              id,
              attemptCount,
              nextAttemptAt,
              error,
            );
          },
        });
      },
      { timeout: this.transactionTimeoutMs },
    );
  }
}
