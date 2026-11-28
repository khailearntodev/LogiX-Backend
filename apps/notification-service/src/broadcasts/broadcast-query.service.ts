import { Injectable } from '@nestjs/common';
import { EntityNotFoundError, ValidationError } from '@logix/errors';
import { isUUID } from 'class-validator';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../database/prisma.service.js';
import {
  DEFAULT_BROADCAST_PAGE_SIZE,
  NOTIFICATION_DELIVERY_STATUSES,
  NOTIFICATION_RECIPIENT_TYPES,
} from '../notifications/notification.constants.js';
import { NOTIFICATION_CHANNELS } from '../notifications/notification.types.js';
import type { ListBroadcastsQueryDto } from './dto/list-broadcasts.dto.js';

export interface BroadcastHistoryItemDto {
  id: string;
  title: string;
  severity: string;
  audience: unknown;
  senderId: string;
  status: string;
  recipientCount: number;
  deliveredCount: number;
  readCount: number;
  createdAt: string;
  completedAt: string | null;
  lastError?: string;
}

export interface ReconcileBroadcastsResult {
  completed: number;
  partialFailed: number;
}

interface BroadcastCursor {
  createdAt: Date;
  id: string;
}

interface BroadcastRowWithNotification {
  id: string;
  notificationId: string;
  createdBy: string;
  audience: Prisma.JsonValue;
  status: string;
  resolvedCount: number;
  createdAt: Date;
  completedAt: Date | null;
  lastError: string | null;
  notification: {
    title: string;
    severity: string;
  };
}

@Injectable()
export class BroadcastQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    tenantId: string,
    query: ListBroadcastsQueryDto,
  ): Promise<{ items: BroadcastHistoryItemDto[]; nextCursor: string | null }> {
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    const limit = query.limit ?? DEFAULT_BROADCAST_PAGE_SIZE;

    const where: Prisma.NotificationBroadcastWhereInput = {
      tenantId,
      deletedAt: null,
      ...(cursor
        ? {
            OR: [
              { createdAt: { lt: cursor.createdAt } },
              { createdAt: cursor.createdAt, id: { lt: cursor.id } },
            ],
          }
        : {}),
    };

    const rows = await this.prisma.notificationBroadcast.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: {
        notification: {
          select: { title: true, severity: true },
        },
      },
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const stats = await this.loadStats(
      tenantId,
      page.map((row) => row.notificationId),
    );
    const last = page.at(-1);

    return {
      items: page.map((row) => this.toItem(row, stats)),
      nextCursor:
        hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
    };
  }

  async getById(
    tenantId: string,
    broadcastId: string,
  ): Promise<BroadcastHistoryItemDto> {
    const row = await this.prisma.notificationBroadcast.findFirst({
      where: {
        id: broadcastId,
        tenantId,
        deletedAt: null,
      },
      include: {
        notification: {
          select: { title: true, severity: true },
        },
      },
    });

    if (!row) {
      throw new EntityNotFoundError('NotificationBroadcast', broadcastId);
    }

    const stats = await this.loadStats(tenantId, [row.notificationId]);
    return this.toItem(row, stats);
  }

  async reconcileReadyBroadcasts(
    limit = 50,
  ): Promise<ReconcileBroadcastsResult> {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new Error('Invalid reconcile limit');
    }

    const rows = await this.prisma.$queryRawUnsafe<Array<{ status: string }>>(
      `
      WITH stats AS (
        SELECT b.id,
          COUNT(d.id) FILTER (WHERE d.status IN ('PENDING', 'PROCESSING', 'RETRY')) AS pending_count,
          COUNT(d.id) FILTER (WHERE d.status = 'FAILED') AS failed_count,
          COUNT(d.id) AS total_count
        FROM notification.notification_broadcasts AS b
        INNER JOIN notification.notification_recipients AS r
          ON r.notification_id = b.notification_id
          AND r.tenant_id = b.tenant_id
          AND r.deleted_at IS NULL
        INNER JOIN notification.notification_deliveries AS d
          ON d.notification_recipient_id = r.id
          AND d.channel = 'IN_APP'
          AND d.deleted_at IS NULL
        WHERE b.status = 'READY'
          AND b.deleted_at IS NULL
        GROUP BY b.id
        HAVING COUNT(d.id) > 0
          AND COUNT(d.id) FILTER (WHERE d.status IN ('PENDING', 'PROCESSING', 'RETRY')) = 0
        LIMIT $1
      )
      UPDATE notification.notification_broadcasts AS target
      SET status = CASE WHEN stats.failed_count > 0 THEN 'PARTIAL_FAILED' ELSE 'COMPLETED' END,
          completed_at = now(),
          updated_at = now(),
          version = target.version + 1
      FROM stats
      WHERE target.id = stats.id
        AND target.status = 'READY'
        AND target.deleted_at IS NULL
      RETURNING target.status
      `,
      limit,
    );

    let completed = 0;
    let partialFailed = 0;
    for (const row of rows) {
      if (row.status === 'PARTIAL_FAILED') {
        partialFailed += 1;
      } else {
        completed += 1;
      }
    }

    return { completed, partialFailed };
  }

  private async loadStats(
    tenantId: string,
    notificationIds: string[],
  ): Promise<{
    readCounts: Map<string, number>;
    deliveredCounts: Map<string, number>;
  }> {
    const readCounts = new Map<string, number>();
    const deliveredCounts = new Map<string, number>();
    const uniqueIds = [...new Set(notificationIds)];
    if (uniqueIds.length === 0) {
      return { readCounts, deliveredCounts };
    }

    const readRows = await this.prisma.notificationRecipient.groupBy({
      by: ['notificationId'],
      where: {
        tenantId,
        notificationId: { in: uniqueIds },
        recipientType: NOTIFICATION_RECIPIENT_TYPES.USER,
        readAt: { not: null },
        deletedAt: null,
      },
      _count: { _all: true },
    });
    for (const row of readRows) {
      readCounts.set(row.notificationId, row._count._all);
    }

    const deliveredRows = await this.prisma.$queryRawUnsafe<
      Array<{ notificationId: string; deliveredCount: bigint | number }>
    >(
      `
      SELECT r.notification_id AS "notificationId",
        COUNT(*)::bigint AS "deliveredCount"
      FROM notification.notification_deliveries AS d
      INNER JOIN notification.notification_recipients AS r
        ON r.id = d.notification_recipient_id
      WHERE r.tenant_id = $1::uuid
        AND r.notification_id = ANY($2::uuid[])
        AND d.channel = $3
        AND d.status = $4
        AND d.deleted_at IS NULL
        AND r.deleted_at IS NULL
      GROUP BY r.notification_id
      `,
      tenantId,
      uniqueIds,
      NOTIFICATION_CHANNELS.IN_APP,
      NOTIFICATION_DELIVERY_STATUSES.SENT,
    );
    for (const row of deliveredRows) {
      deliveredCounts.set(row.notificationId, Number(row.deliveredCount));
    }

    return { readCounts, deliveredCounts };
  }

  private toItem(
    row: BroadcastRowWithNotification,
    stats: {
      readCounts: Map<string, number>;
      deliveredCounts: Map<string, number>;
    },
  ): BroadcastHistoryItemDto {
    return {
      id: row.id,
      title: row.notification.title,
      severity: row.notification.severity,
      audience: row.audience,
      senderId: row.createdBy,
      status: row.status,
      recipientCount: row.resolvedCount,
      deliveredCount: stats.deliveredCounts.get(row.notificationId) ?? 0,
      readCount: stats.readCounts.get(row.notificationId) ?? 0,
      createdAt: row.createdAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
      ...(row.lastError ? { lastError: row.lastError } : {}),
    };
  }
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(
    JSON.stringify({ createdAt: createdAt.toISOString(), id }),
  ).toString('base64url');
}

function decodeCursor(value: string): BroadcastCursor {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) {
      throw new Error('Invalid cursor encoding');
    }
    const parsed: unknown = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    );
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Invalid cursor');
    }

    const cursor = parsed as { createdAt?: unknown; id?: unknown };
    if (typeof cursor.createdAt !== 'string' || typeof cursor.id !== 'string') {
      throw new Error('Invalid cursor fields');
    }

    const createdAt = new Date(cursor.createdAt);
    if (Number.isNaN(createdAt.getTime()) || !isUUID(cursor.id)) {
      throw new Error('Invalid cursor values');
    }
    return { createdAt, id: cursor.id };
  } catch {
    throw new ValidationError('Cursor phân trang không hợp lệ');
  }
}
