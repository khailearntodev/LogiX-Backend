import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import {
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { CommandEventEnvelope } from './event-envelope.js';
import type { KafkaProducerService } from './kafka-producer.service.js';
import { outboxRetryDelay } from './outbox-relay.js';

const MAX_WORKER_ID_LENGTH = 100;
const MAX_ERROR_LENGTH = 1000;

export interface ClaimedOutboxRecord {
  id: string;
  topic: string;
  attemptCount: number;
  envelope: CommandEventEnvelope;
}

export interface ClaimLeaseOutboxStore {
  claimBatch(
    batchSize: number,
    workerId: string,
    leaseMs: number,
  ): Promise<ClaimedOutboxRecord[]>;
  markPublished(id: string, workerId: string, publishedAt: Date): Promise<void>;
  markFailed(
    id: string,
    workerId: string,
    attemptCount: number,
    nextAttemptAt: Date,
    error: string,
  ): Promise<void>;
}

export interface ClaimLeaseOutboxRelayOptions {
  defaultTopic?: string;
  workerId?: string;
  intervalMs: number;
  batchSize: number;
  leaseMs: number;
  publishTimeoutMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
}

/**
 * ClaimLeaseOutboxRelay — Publishes outbox records without holding database
 * locks or interactive transactions open across Kafka network calls or retries.
 */
export class ClaimLeaseOutboxRelay implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ClaimLeaseOutboxRelay.name);
  private readonly workerId: string;
  private readonly defaultTopic?: string;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private running: Promise<void> | undefined;

  constructor(
    private readonly store: ClaimLeaseOutboxStore,
    private readonly producer: Pick<KafkaProducerService, 'publishRaw'>,
    private readonly options: ClaimLeaseOutboxRelayOptions,
  ) {
    if (
      [
        options.intervalMs,
        options.batchSize,
        options.leaseMs,
        options.publishTimeoutMs,
        options.retryBaseMs,
        options.retryMaxMs,
      ].some((value) => !Number.isSafeInteger(value) || value <= 0) ||
      options.retryMaxMs < options.retryBaseMs ||
      options.leaseMs <= options.publishTimeoutMs
    ) {
      throw new Error('Invalid claim-lease outbox relay configuration');
    }

    if (options.defaultTopic !== undefined) {
      const trimmedTopic = options.defaultTopic.trim();
      if (!trimmedTopic) {
        throw new Error('Invalid claim-lease outbox relay configuration');
      }
      this.defaultTopic = trimmedTopic;
    }

    if (options.workerId !== undefined) {
      const trimmedWorkerId = options.workerId.trim();
      if (
        !trimmedWorkerId ||
        trimmedWorkerId.length > MAX_WORKER_ID_LENGTH
      ) {
        throw new Error('Invalid claim-lease outbox relay configuration');
      }
      this.workerId = trimmedWorkerId;
    } else {
      this.workerId = `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`
        .slice(0, MAX_WORKER_ID_LENGTH);
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

  async flush(): Promise<number> {
    const records = await this.store.claimBatch(
      this.options.batchSize,
      this.workerId,
      this.options.leaseMs,
    );

    for (const record of records) {
      const topic = record.topic.trim() || this.defaultTopic || '';
      if (!topic) {
        const attemptCount = record.attemptCount + 1;
        await this.store.markFailed(
          record.id,
          this.workerId,
          attemptCount,
          this.nextRetryAt(attemptCount),
          'Outbox record topic is missing',
        );
        this.logger.error({
          eventId: record.id,
          topic: record.topic,
          attemptCount,
          correlationId: record.envelope.correlationId,
          workerId: this.workerId,
          message: 'Outbox publication failed; topic is missing',
        });
        continue;
      }

      try {
        await this.publishWithTimeout(topic, record.envelope);
      } catch (error) {
        const attemptCount = record.attemptCount + 1;
        const message = this.sanitizeErrorMessage(error);
        await this.store.markFailed(
          record.id,
          this.workerId,
          attemptCount,
          this.nextRetryAt(attemptCount),
          message,
        );
        this.logger.error({
          eventId: record.id,
          topic,
          attemptCount,
          correlationId: record.envelope.correlationId,
          workerId: this.workerId,
          message: 'Outbox publication failed; retry scheduled',
        });
        continue;
      }

      // Never mark a database failure as a broker failure. Re-delivery after commit
      // failure is expected: consumers deduplicate using the unchanged eventId.
      await this.store.markPublished(record.id, this.workerId, new Date());
    }

    return records.length;
  }

  private async publishWithTimeout(
    topic: string,
    envelope: CommandEventEnvelope,
  ): Promise<void> {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(
          new Error(
            `Kafka publish timed out after ${this.options.publishTimeoutMs}ms`,
          ),
        );
      }, this.options.publishTimeoutMs);
    });

    try {
      await Promise.race([
        this.producer.publishRaw(topic, envelope),
        timeoutPromise,
      ]);
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  private nextRetryAt(attemptCount: number): Date {
    return new Date(
      Date.now() +
        outboxRetryDelay(
          attemptCount,
          this.options.retryBaseMs,
          this.options.retryMaxMs,
        ),
    );
  }

  private sanitizeErrorMessage(error: unknown): string {
    const raw =
      error instanceof Error && error.message.trim()
        ? error.message
        : 'Kafka publish failed';
    return raw.slice(0, MAX_ERROR_LENGTH);
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.running = this.flush()
        .then(() => undefined)
        .catch((error: unknown) => {
          this.logger.error(
            error instanceof Error ? error : 'Outbox flush failed',
          );
        })
        .finally(() => {
          this.running = undefined;
          if (!this.stopped) this.schedule(this.options.intervalMs);
        });
    }, delayMs);
  }
}
