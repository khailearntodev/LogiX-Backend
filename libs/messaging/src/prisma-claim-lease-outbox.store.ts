import type { ServiceId } from '@logix/common';
import type {
  ClaimedOutboxRecord,
  ClaimLeaseOutboxStore,
} from './claim-lease-outbox-relay.js';
import type { OutboxDatabase } from './prisma-outbox.store.js';

export type ClaimLeaseOutboxSchema = 'identity' | 'notification';

const ALLOWED_SCHEMAS = new Set<string>(['identity', 'notification']);

interface ClaimedOutboxRow {
  id: string;
  tenantId: string | null;
  topic: string;
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

/**
 * PrismaClaimLeaseOutboxStore — Short-transaction claim/lease adapter for
 * `identity.outbox_events` and `notification.outbox_events`.
 */
export class PrismaClaimLeaseOutboxStore implements ClaimLeaseOutboxStore {
  constructor(
    private readonly database: OutboxDatabase,
    private readonly schema: ClaimLeaseOutboxSchema,
    private readonly producer: ServiceId,
    private readonly transactionTimeoutMs: number,
  ) {
    if (
      !ALLOWED_SCHEMAS.has(schema) ||
      !Number.isSafeInteger(transactionTimeoutMs) ||
      transactionTimeoutMs <= 0
    ) {
      throw new Error('Invalid claim-lease outbox store configuration');
    }
  }

  async claimBatch(
    batchSize: number,
    workerId: string,
    leaseMs: number,
  ): Promise<ClaimedOutboxRecord[]> {
    const trimmedWorkerId = workerId.trim();
    if (
      !Number.isSafeInteger(batchSize) ||
      batchSize <= 0 ||
      !Number.isSafeInteger(leaseMs) ||
      leaseMs <= 0 ||
      !trimmedWorkerId
    ) {
      throw new Error('Invalid outbox claim arguments');
    }

    const rows = await this.database.$transaction(
      async (tx) => {
        // Schema is a constructor-validated owner constant; all data is parameterized.
        return tx.$queryRawUnsafe<ClaimedOutboxRow[]>(
          `
          WITH claimed AS (
            SELECT event.id
            FROM ${this.schema}.outbox_events AS event
            WHERE event.published_at IS NULL
              AND event.deleted_at IS NULL
              AND event.next_attempt_at <= now()
              AND (event.locked_until IS NULL OR event.locked_until < now())
              AND NOT EXISTS (
                SELECT 1
                FROM ${this.schema}.outbox_events AS earlier
                WHERE earlier.tenant_id IS NOT DISTINCT FROM event.tenant_id
                  AND earlier.aggregate_type = event.aggregate_type
                  AND earlier.aggregate_id = event.aggregate_id
                  AND earlier.published_at IS NULL
                  AND earlier.deleted_at IS NULL
                  AND (earlier.aggregate_version, earlier.occurred_at, earlier.id)
                    < (event.aggregate_version, event.occurred_at, event.id)
              )
            ORDER BY event.occurred_at, event.id
            LIMIT $1
            FOR UPDATE OF event SKIP LOCKED
          )
          UPDATE ${this.schema}.outbox_events AS target
          SET locked_by = $2,
              locked_until = now() + ($3 * interval '1 millisecond'),
              updated_at = now(),
              version = target.version + 1
          FROM claimed
          WHERE target.id = claimed.id
          RETURNING target.id,
            target.tenant_id AS "tenantId",
            target.topic,
            target.event_type AS "eventType",
            target.event_version AS "eventVersion",
            target.aggregate_type AS "aggregateType",
            target.aggregate_id AS "aggregateId",
            target.aggregate_version AS "aggregateVersion",
            target.correlation_id AS "correlationId",
            target.causation_id AS "causationId",
            target.payload,
            target.occurred_at AS "occurredAt",
            target.attempt_count AS "attemptCount"
        `,
          batchSize,
          trimmedWorkerId,
          leaseMs,
        );
      },
      { timeout: this.transactionTimeoutMs },
    );

    return rows.map((row) => {
      const aggregateVersion = Number(row.aggregateVersion);
      if (!Number.isSafeInteger(aggregateVersion)) {
        throw new Error(`Outbox aggregate version is unsafe: ${row.id}`);
      }

      const actorId =
        row.payload &&
        typeof row.payload === 'object' &&
        !Array.isArray(row.payload) &&
        'actorId' in row.payload &&
        typeof row.payload.actorId === 'string'
          ? row.payload.actorId
          : null;

      return {
        id: row.id,
        topic: row.topic,
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
  }

  async markPublished(
    id: string,
    workerId: string,
    publishedAt: Date,
  ): Promise<void> {
    await this.database.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(
          `
          UPDATE ${this.schema}.outbox_events
          SET published_at = $3,
              locked_by = NULL,
              locked_until = NULL,
              last_error = NULL,
              updated_at = now(),
              version = version + 1
          WHERE id = $1::uuid
            AND locked_by = $2
            AND published_at IS NULL
            AND deleted_at IS NULL
        `,
          id,
          workerId,
          publishedAt,
        );
      },
      { timeout: this.transactionTimeoutMs },
    );
  }

  async markFailed(
    id: string,
    workerId: string,
    attemptCount: number,
    nextAttemptAt: Date,
    error: string,
  ): Promise<void> {
    await this.database.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(
          `
          UPDATE ${this.schema}.outbox_events
          SET attempt_count = $3,
              next_attempt_at = $4,
              last_error = $5,
              locked_by = NULL,
              locked_until = NULL,
              updated_at = now(),
              version = version + 1
          WHERE id = $1::uuid
            AND locked_by = $2
            AND published_at IS NULL
            AND deleted_at IS NULL
        `,
          id,
          workerId,
          attemptCount,
          nextAttemptAt,
          error,
        );
      },
      { timeout: this.transactionTimeoutMs },
    );
  }
}
