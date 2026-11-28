import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { NOTIFICATION_RECIPIENT_TYPES } from '../notifications/notification.constants.js';
import { toJsonRecord } from '../notifications/notification-link.js';

export interface ClaimedDeliveryJob {
  deliveryId: string;
  notificationRecipientId: string;
  notificationId: string;
  tenantId: string;
  recipientUserId: string;
  attemptCount: number;
  type: string;
  title: string;
  body: string;
  severity: string;
  entityType: string | null;
  entityId: string | null;
  data: Record<string, unknown>;
  createdAt: Date;
  readAt: Date | null;
  archivedAt: Date | null;
}

export interface ReclaimLeasesResult {
  reclaimedToRetry: number;
  markedFailed: number;
}

export interface DeliveryStore {
  claimInAppBatch(
    batchSize: number,
    workerId: string,
    leaseMs: number,
  ): Promise<ClaimedDeliveryJob[]>;
  loadUnreadCounts(
    tenantId: string,
    userIds: string[],
  ): Promise<Map<string, number>>;
  markSent(
    deliveryId: string,
    workerId: string,
    sentAt: Date,
  ): Promise<boolean>;
  markRetry(
    deliveryId: string,
    workerId: string,
    attemptCount: number,
    nextAttemptAt: Date,
    lastError: string,
  ): Promise<boolean>;
  markFailed(
    deliveryId: string,
    workerId: string,
    attemptCount: number,
    lastError: string,
  ): Promise<boolean>;
  reclaimExpiredLeases(
    maxAttempts: number,
    retryBaseMs: number,
    retryMaxMs: number,
    limit: number,
  ): Promise<ReclaimLeasesResult>;
}

interface ClaimedDeliveryRow {
  deliveryId: string;
  notificationRecipientId: string;
  attemptCount: number;
  notificationId: string;
  tenantId: string;
  recipientUserId: string;
  readAt: Date | null;
  archivedAt: Date | null;
  type: string;
  title: string;
  body: string;
  severity: string;
  entityType: string | null;
  entityId: string | null;
  data: unknown;
  createdAt: Date;
}

@Injectable()
export class PrismaDeliveryStore implements DeliveryStore {
  constructor(
    private readonly prisma: PrismaService,
    private readonly txTimeoutMs: number = 5000,
  ) {
    if (!Number.isSafeInteger(txTimeoutMs) || txTimeoutMs <= 0) {
      throw new Error('Invalid delivery store transaction timeout');
    }
  }

  async claimInAppBatch(
    batchSize: number,
    workerId: string,
    leaseMs: number,
  ): Promise<ClaimedDeliveryJob[]> {
    const trimmedWorkerId = workerId.trim();
    if (
      !Number.isSafeInteger(batchSize) ||
      batchSize <= 0 ||
      !Number.isSafeInteger(leaseMs) ||
      leaseMs <= 0 ||
      !trimmedWorkerId
    ) {
      throw new Error('Invalid delivery claim arguments');
    }

    const rows = await this.prisma.$transaction(
      async (tx) =>
        tx.$queryRawUnsafe<ClaimedDeliveryRow[]>(
          `
          WITH claimed AS (
            SELECT d.id
            FROM notification.notification_deliveries AS d
            INNER JOIN notification.notification_recipients AS r
              ON r.id = d.notification_recipient_id
            INNER JOIN notification.notifications AS n
              ON n.id = r.notification_id
            WHERE d.channel = 'IN_APP'
              AND d.status IN ('PENDING', 'RETRY')
              AND d.next_attempt_at <= now()
              AND d.deleted_at IS NULL
              AND r.deleted_at IS NULL
              AND n.deleted_at IS NULL
              AND r.recipient_type = 'USER'
            ORDER BY d.next_attempt_at ASC, d.created_at ASC, d.id ASC
            LIMIT $1
            FOR UPDATE OF d SKIP LOCKED
          ),
          updated AS (
            UPDATE notification.notification_deliveries AS target
            SET status = 'PROCESSING',
                locked_by = $2,
                locked_until = now() + ($3 * interval '1 millisecond'),
                updated_at = now(),
                version = target.version + 1
            FROM claimed
            WHERE target.id = claimed.id
            RETURNING target.id,
              target.notification_recipient_id,
              target.attempt_count
          )
          SELECT u.id AS "deliveryId",
            u.notification_recipient_id AS "notificationRecipientId",
            u.attempt_count AS "attemptCount",
            r.notification_id AS "notificationId",
            r.tenant_id AS "tenantId",
            r.recipient_id AS "recipientUserId",
            r.read_at AS "readAt",
            r.archived_at AS "archivedAt",
            n.type,
            n.title,
            n.body,
            n.severity,
            n.entity_type AS "entityType",
            n.entity_id AS "entityId",
            n.data,
            n.created_at AS "createdAt"
          FROM updated AS u
          INNER JOIN notification.notification_recipients AS r
            ON r.id = u.notification_recipient_id
          INNER JOIN notification.notifications AS n
            ON n.id = r.notification_id
          `,
          batchSize,
          trimmedWorkerId,
          leaseMs,
        ),
      { timeout: this.txTimeoutMs },
    );

    return rows.map((row) => ({
      deliveryId: row.deliveryId,
      notificationRecipientId: row.notificationRecipientId,
      notificationId: row.notificationId,
      tenantId: row.tenantId,
      recipientUserId: row.recipientUserId,
      attemptCount: row.attemptCount,
      type: row.type,
      title: row.title,
      body: row.body,
      severity: row.severity,
      entityType: row.entityType,
      entityId: row.entityId,
      data: toJsonRecord(row.data),
      createdAt: row.createdAt,
      readAt: row.readAt,
      archivedAt: row.archivedAt,
    }));
  }

  async loadUnreadCounts(
    tenantId: string,
    userIds: string[],
  ): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    const uniqueUserIds = [...new Set(userIds)];
    if (uniqueUserIds.length === 0) return counts;

    const grouped = await this.prisma.notificationRecipient.groupBy({
      by: ['recipientId'],
      where: {
        tenantId,
        recipientType: NOTIFICATION_RECIPIENT_TYPES.USER,
        recipientId: { in: uniqueUserIds },
        readAt: null,
        archivedAt: null,
        deletedAt: null,
        notification: { tenantId, deletedAt: null },
      },
      _count: { _all: true },
    });

    for (const row of grouped) {
      counts.set(row.recipientId, row._count._all);
    }

    return counts;
  }

  async markSent(
    deliveryId: string,
    workerId: string,
    sentAt: Date,
  ): Promise<boolean> {
    const affected = await this.prisma.$transaction(
      async (tx) =>
        tx.$executeRawUnsafe(
          `
          UPDATE notification.notification_deliveries
          SET status = 'SENT',
              attempt_count = attempt_count + 1,
              sent_at = $3,
              locked_by = NULL,
              locked_until = NULL,
              last_error = NULL,
              updated_at = now(),
              version = version + 1
          WHERE id = $1::uuid
            AND status = 'PROCESSING'
            AND locked_by = $2
            AND deleted_at IS NULL
          `,
          deliveryId,
          workerId,
          sentAt,
        ),
      { timeout: this.txTimeoutMs },
    );

    return affected > 0;
  }

  async markRetry(
    deliveryId: string,
    workerId: string,
    attemptCount: number,
    nextAttemptAt: Date,
    lastError: string,
  ): Promise<boolean> {
    const affected = await this.prisma.$transaction(
      async (tx) =>
        tx.$executeRawUnsafe(
          `
          UPDATE notification.notification_deliveries
          SET status = 'RETRY',
              attempt_count = $3,
              next_attempt_at = $4,
              locked_by = NULL,
              locked_until = NULL,
              last_error = $5,
              updated_at = now(),
              version = version + 1
          WHERE id = $1::uuid
            AND status = 'PROCESSING'
            AND locked_by = $2
            AND deleted_at IS NULL
          `,
          deliveryId,
          workerId,
          attemptCount,
          nextAttemptAt,
          lastError,
        ),
      { timeout: this.txTimeoutMs },
    );

    return affected > 0;
  }

  async markFailed(
    deliveryId: string,
    workerId: string,
    attemptCount: number,
    lastError: string,
  ): Promise<boolean> {
    const affected = await this.prisma.$transaction(
      async (tx) =>
        tx.$executeRawUnsafe(
          `
          UPDATE notification.notification_deliveries
          SET status = 'FAILED',
              attempt_count = $3,
              locked_by = NULL,
              locked_until = NULL,
              last_error = $4,
              updated_at = now(),
              version = version + 1
          WHERE id = $1::uuid
            AND status = 'PROCESSING'
            AND locked_by = $2
            AND deleted_at IS NULL
          `,
          deliveryId,
          workerId,
          attemptCount,
          lastError,
        ),
      { timeout: this.txTimeoutMs },
    );

    return affected > 0;
  }

  async reclaimExpiredLeases(
    maxAttempts: number,
    retryBaseMs: number,
    retryMaxMs: number,
    limit: number,
  ): Promise<ReclaimLeasesResult> {
    if (
      [maxAttempts, retryBaseMs, retryMaxMs, limit].some(
        (value) => !Number.isSafeInteger(value) || value <= 0,
      ) ||
      retryMaxMs < retryBaseMs
    ) {
      throw new Error('Invalid lease reclaim arguments');
    }

    const rows = await this.prisma.$transaction(
      async (tx) =>
        tx.$queryRawUnsafe<Array<{ status: string }>>(
          `
          WITH expired AS (
            SELECT d.id
            FROM notification.notification_deliveries AS d
            WHERE d.status = 'PROCESSING'
              AND d.locked_until < now()
              AND d.deleted_at IS NULL
            ORDER BY d.locked_until ASC
            LIMIT $1
            FOR UPDATE OF d SKIP LOCKED
          )
          UPDATE notification.notification_deliveries AS target
          SET attempt_count = target.attempt_count + 1,
              status = CASE
                WHEN target.attempt_count + 1 >= $2 THEN 'FAILED'
                ELSE 'RETRY'
              END,
              next_attempt_at = CASE
                WHEN target.attempt_count + 1 >= $2 THEN target.next_attempt_at
                ELSE now() + (
                  LEAST(
                    $4::double precision,
                    $3::double precision * power(2, LEAST(target.attempt_count, 30))
                  ) * interval '1 millisecond'
                )
              END,
              last_error = CASE
                WHEN target.attempt_count + 1 >= $2 THEN 'LEASE_EXPIRED_MAX_ATTEMPTS'
                ELSE 'LEASE_EXPIRED'
              END,
              locked_by = NULL,
              locked_until = NULL,
              updated_at = now(),
              version = target.version + 1
          FROM expired
          WHERE target.id = expired.id
          RETURNING target.status
          `,
          limit,
          maxAttempts,
          retryBaseMs,
          retryMaxMs,
        ),
      { timeout: this.txTimeoutMs },
    );

    let reclaimedToRetry = 0;
    let markedFailed = 0;
    for (const row of rows) {
      if (row.status === 'FAILED') {
        markedFailed += 1;
      } else {
        reclaimedToRetry += 1;
      }
    }

    return { reclaimedToRetry, markedFailed };
  }
}
