import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import {
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { NotificationCoreService } from '../notifications/notification-core.service.js';
import { resolveNotificationLink } from '../notifications/notification-link.js';
import { PermanentDeliveryError } from './delivery.errors.js';
import type {
  ClaimedDeliveryJob,
  DeliveryStore,
  ReclaimLeasesResult,
} from './prisma-delivery.store.js';

const MAX_WORKER_ID_LENGTH = 100;
const MAX_ERROR_LENGTH = 1000;

export interface InAppDeliveryWorkerOptions {
  enabled: boolean;
  pollIntervalMs: number;
  batchSize: number;
  concurrency: number;
  leaseMs: number;
  maxAttempts: number;
  retryBaseMs: number;
  retryMaxMs: number;
  reclaimIntervalMs: number;
  workerId?: string;
}

export function deliveryRetryDelay(
  attemptCount: number,
  baseMs: number,
  maxMs: number,
): number {
  return Math.min(maxMs, baseMs * 2 ** Math.min(Math.max(attemptCount - 1, 0), 30));
}

export class InAppDeliveryWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InAppDeliveryWorker.name);
  private readonly workerId: string;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private reclaimTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private runningPoll: Promise<void> | undefined;
  private runningReclaim: Promise<void> | undefined;

  constructor(
    private readonly store: DeliveryStore,
    private readonly core: Pick<NotificationCoreService, 'dispatchInApp'>,
    private readonly options: InAppDeliveryWorkerOptions,
  ) {
    if (
      [
        options.pollIntervalMs,
        options.batchSize,
        options.concurrency,
        options.leaseMs,
        options.maxAttempts,
        options.retryBaseMs,
        options.retryMaxMs,
        options.reclaimIntervalMs,
      ].some((value) => !Number.isSafeInteger(value) || value <= 0) ||
      options.retryMaxMs < options.retryBaseMs
    ) {
      throw new Error('Invalid in-app delivery worker configuration');
    }

    if (options.workerId !== undefined) {
      const trimmed = options.workerId.trim();
      if (!trimmed || trimmed.length > MAX_WORKER_ID_LENGTH) {
        throw new Error('Invalid in-app delivery worker configuration');
      }
      this.workerId = trimmed;
    } else {
      this.workerId = `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`
        .slice(0, MAX_WORKER_ID_LENGTH);
    }
  }

  onModuleInit(): void {
    if (!this.options.enabled) return;
    this.stopped = false;
    this.schedulePoll(0);
    this.scheduleReclaim(this.options.reclaimIntervalMs);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.pollTimer);
    clearTimeout(this.reclaimTimer);
    await Promise.all([this.runningPoll, this.runningReclaim]);
  }

  wakeUp(): void {
    if (this.stopped || !this.options.enabled || this.runningPoll) return;
    clearTimeout(this.pollTimer);
    this.schedulePoll(0);
  }

  async processBatch(): Promise<number> {
    const jobs = await this.store.claimInAppBatch(
      this.options.batchSize,
      this.workerId,
      this.options.leaseMs,
    );
    if (jobs.length === 0) return 0;

    const unreadCountsByTenant = await this.loadUnreadCountsByTenant(jobs);
    const workerCount = Math.min(this.options.concurrency, jobs.length);
    let nextIndex = 0;

    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (true) {
          const index = nextIndex;
          nextIndex += 1;
          if (index >= jobs.length) return;
          const job = jobs[index];
          await this.deliverOne(
            job,
            unreadCountsByTenant.get(job.tenantId)?.get(job.recipientUserId),
          );
        }
      }),
    );

    return jobs.length;
  }

  async reclaimExpired(): Promise<ReclaimLeasesResult> {
    const result = await this.store.reclaimExpiredLeases(
      this.options.maxAttempts,
      this.options.retryBaseMs,
      this.options.retryMaxMs,
      this.options.batchSize,
    );
    if (result.reclaimedToRetry + result.markedFailed > 0) {
      this.logger.warn({
        workerId: this.workerId,
        reclaimedToRetry: result.reclaimedToRetry,
        markedFailed: result.markedFailed,
        message: 'Reclaimed expired in-app delivery leases',
      });
    }
    return result;
  }

  private async loadUnreadCountsByTenant(
    jobs: ClaimedDeliveryJob[],
  ): Promise<Map<string, Map<string, number>>> {
    const usersByTenant = new Map<string, Set<string>>();
    for (const job of jobs) {
      let users = usersByTenant.get(job.tenantId);
      if (!users) {
        users = new Set<string>();
        usersByTenant.set(job.tenantId, users);
      }
      users.add(job.recipientUserId);
    }

    const result = new Map<string, Map<string, number>>();
    for (const [tenantId, users] of usersByTenant.entries()) {
      try {
        result.set(
          tenantId,
          await this.store.loadUnreadCounts(tenantId, [...users]),
        );
      } catch (error) {
        this.logger.warn({
          tenantId,
          message:
            error instanceof Error
              ? error.message
              : 'Failed to load unread notification counts',
        });
      }
    }

    return result;
  }

  private async deliverOne(
    job: ClaimedDeliveryJob,
    unreadCount: number | undefined,
  ): Promise<void> {
    try {
      await this.core.dispatchInApp({
        notificationId: job.notificationId,
        tenantId: job.tenantId,
        recipientUserId: job.recipientUserId,
        unreadCount,
        payload: {
          id: job.notificationId,
          tenantId: job.tenantId,
          type: job.type,
          title: job.title,
          body: job.body,
          link: resolveNotificationLink(job.entityType, job.entityId, job.data),
          severity: job.severity,
          entityType: job.entityType,
          entityId: job.entityId,
          data: job.data,
          createdAt: job.createdAt.toISOString(),
          readAt: job.readAt?.toISOString() ?? null,
          archivedAt: job.archivedAt?.toISOString() ?? null,
        },
      });
    } catch (error) {
      const nextAttempt = job.attemptCount + 1;
      const errorMessage = sanitizeErrorMessage(error);

      if (
        error instanceof PermanentDeliveryError ||
        nextAttempt >= this.options.maxAttempts
      ) {
        await this.store.markFailed(
          job.deliveryId,
          this.workerId,
          nextAttempt,
          errorMessage,
        );
        this.logger.warn({
          deliveryId: job.deliveryId,
          notificationId: job.notificationId,
          tenantId: job.tenantId,
          status: 'FAILED',
          attemptCount: nextAttempt,
        });
        return;
      }

      const nextAttemptAt = new Date(
        Date.now() +
          deliveryRetryDelay(
            nextAttempt,
            this.options.retryBaseMs,
            this.options.retryMaxMs,
          ),
      );
      await this.store.markRetry(
        job.deliveryId,
        this.workerId,
        nextAttempt,
        nextAttemptAt,
        errorMessage,
      );
      this.logger.warn({
        deliveryId: job.deliveryId,
        notificationId: job.notificationId,
        tenantId: job.tenantId,
        status: 'RETRY',
        attemptCount: nextAttempt,
      });
      return;
    }

    await this.store.markSent(job.deliveryId, this.workerId, new Date());
  }

  private schedulePoll(delayMs: number): void {
    this.pollTimer = setTimeout(() => {
      let processedCount = 0;
      this.runningPoll = this.processBatch()
        .then((count) => {
          processedCount = count;
        })
        .catch((error: unknown) => {
          this.logger.error(
            error instanceof Error ? error : 'In-app delivery batch failed',
          );
        })
        .finally(() => {
          this.runningPoll = undefined;
          if (!this.stopped) {
            const nextDelay =
              processedCount >= this.options.batchSize
                ? 0
                : this.options.pollIntervalMs;
            this.schedulePoll(nextDelay);
          }
        });
    }, delayMs);
  }

  private scheduleReclaim(delayMs: number): void {
    this.reclaimTimer = setTimeout(() => {
      this.runningReclaim = this.reclaimExpired()
        .then(() => undefined)
        .catch((error: unknown) => {
          this.logger.error(
            error instanceof Error ? error : 'In-app lease reclaim failed',
          );
        })
        .finally(() => {
          this.runningReclaim = undefined;
          if (!this.stopped) {
            this.scheduleReclaim(this.options.reclaimIntervalMs);
          }
        });
    }, delayMs);
  }
}

function sanitizeErrorMessage(error: unknown): string {
  const raw =
    error instanceof Error && error.message.trim()
      ? error.message
      : 'In-app realtime delivery failed';
  return raw.slice(0, MAX_ERROR_LENGTH);
}
