import {
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { DomainEventEnvelope } from './event-envelope.js';
import type { KafkaProducerService } from './kafka-producer.service.js';

export interface OutboxRelayOptions {
  topic: string;
  intervalMs: number;
  batchSize: number;
  retryBaseMs: number;
  retryMaxMs: number;
}

export interface OutboxRelayRecord {
  id: string;
  attemptCount: number;
  envelope: DomainEventEnvelope;
}

export interface OutboxRelayTransaction {
  markPublished(id: string, publishedAt: Date): Promise<void>;
  markFailed(
    id: string,
    attemptCount: number,
    nextAttemptAt: Date,
    error: string,
  ): Promise<void>;
}

export interface OutboxRelayStore {
  // The service-owned adapter must hold FOR UPDATE SKIP LOCKED until callback completion.
  withLockedBatch(
    batchSize: number,
    callback: (
      records: OutboxRelayRecord[],
      tx: OutboxRelayTransaction,
    ) => Promise<void>,
  ): Promise<void>;
}

export function outboxRetryDelay(
  attemptCount: number,
  baseMs: number,
  maxMs: number,
): number {
  return Math.min(maxMs, baseMs * 2 ** Math.min(attemptCount - 1, 30));
}

export class OutboxRelay implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelay.name);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private running: Promise<void> | undefined;

  constructor(
    private readonly store: OutboxRelayStore,
    private readonly producer: Pick<KafkaProducerService, 'publishRaw'>,
    private readonly options: OutboxRelayOptions,
  ) {
    if (
      !options.topic.trim() ||
      [
        options.intervalMs,
        options.batchSize,
        options.retryBaseMs,
        options.retryMaxMs,
      ].some((value) => !Number.isSafeInteger(value) || value <= 0) ||
      options.retryMaxMs < options.retryBaseMs
    ) {
      throw new Error('Invalid outbox relay configuration');
    }
  }

  onModuleInit(): void {
    this.stopped = false;
    this.schedule(0);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }

  async flush(): Promise<void> {
    await this.store.withLockedBatch(
      this.options.batchSize,
      async (records, tx) => {
        for (const record of records) {
          try {
            await this.producer.publishRaw(this.options.topic, record.envelope);
          } catch (error) {
            const attemptCount = record.attemptCount + 1;
            const message =
              error instanceof Error ? error.message : 'Kafka publish failed';
            await tx.markFailed(
              record.id,
              attemptCount,
              new Date(
                Date.now() +
                  outboxRetryDelay(
                    attemptCount,
                    this.options.retryBaseMs,
                    this.options.retryMaxMs,
                  ),
              ),
              message,
            );
            this.logger.error(
              {
                eventId: record.id,
                attemptCount,
                correlationId: record.envelope.correlationId,
              },
              'Outbox publication failed; retry scheduled',
            );
            continue;
          }
          // Never mark a database failure as a broker failure. Re-delivery after commit
          // failure is expected: consumers deduplicate using the unchanged eventId.
          await tx.markPublished(record.id, new Date());
        }
      },
    );
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.running = this.flush()
        .catch((error: unknown) => {
          this.logger.error(
            error instanceof Error ? error : 'Outbox transaction failed',
          );
        })
        .finally(() => {
          this.running = undefined;
          if (!this.stopped) this.schedule(this.options.intervalMs);
        });
    }, delayMs);
  }
}
