import { Injectable, Logger } from '@nestjs/common';
import type { AuthenticatedUser } from '@logix/auth';
import { EntityNotFoundError, ValidationError } from '@logix/errors';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../database/prisma.service.js';
import { NotificationsGateway } from '../realtime/notifications.gateway.js';
import {
  DEFAULT_NOTIFICATION_PAGE_SIZE,
  NOTIFICATION_RECIPIENT_TYPES,
} from './notification.constants.js';
import {
  resolveNotificationLink,
  toJsonRecord,
} from './notification-link.js';
import type { NotificationItemDto } from './notification.types.js';
import type { ListNotificationsQueryDto } from './dto/list-notifications.dto.js';

interface NotificationCursor {
  createdAt: Date;
  id: string;
}

interface NotificationRecipientScope {
  tenantId: string;
  recipientType: typeof NOTIFICATION_RECIPIENT_TYPES.USER;
  recipientId: string;
  deletedAt: null;
  archivedAt?: null;
  readAt?: null;
}

@Injectable()
export class NotificationInboxService {
  private readonly logger = new Logger(NotificationInboxService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: NotificationsGateway,
  ) {}

  async list(
    user: AuthenticatedUser,
    query: ListNotificationsQueryDto,
  ): Promise<{ items: NotificationItemDto[]; nextCursor: string | null }> {
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    const limit = query.limit ?? DEFAULT_NOTIFICATION_PAGE_SIZE;
    const recipientScope = this.recipientScope(user, query);
    const where: Prisma.NotificationWhereInput = {
      tenantId: user.tenantId,
      deletedAt: null,
      recipients: { some: recipientScope },
      ...(cursor
        ? {
            OR: [
              { createdAt: { lt: cursor.createdAt } },
              { createdAt: cursor.createdAt, id: { lt: cursor.id } },
            ],
          }
        : {}),
    };

    const notifications = await this.prisma.notification.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: {
        recipients: {
          where: recipientScope,
          take: 1,
        },
      },
    });

    const hasMore = notifications.length > limit;
    const page = hasMore ? notifications.slice(0, limit) : notifications;
    const last = page.at(-1);

    return {
      items: page.flatMap((notification) => {
        const recipient = notification.recipients[0];
        return recipient ? [this.toItem(notification, recipient)] : [];
      }),
      nextCursor:
        hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
    };
  }

  async unreadCount(user: AuthenticatedUser): Promise<{ count: number }> {
    const count = await this.prisma.notificationRecipient.count({
      where: {
        tenantId: user.tenantId,
        recipientType: NOTIFICATION_RECIPIENT_TYPES.USER,
        recipientId: user.id,
        readAt: null,
        archivedAt: null,
        deletedAt: null,
        notification: { tenantId: user.tenantId, deletedAt: null },
      },
    });
    return { count };
  }

  async markRead(user: AuthenticatedUser, notificationId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const recipient = await this.findOwnedRecipient(tx, user, notificationId);
      if (!recipient) throw new EntityNotFoundError('Notification', notificationId);

      if (!recipient.readAt) {
        await tx.notificationRecipient.update({
          where: { id: recipient.id },
          data: { readAt: new Date(), version: { increment: 1 } },
        });
      }
    });

    await this.publishUnreadCount(user);
  }

  async markAllRead(user: AuthenticatedUser): Promise<{ updated: number }> {
    const result = await this.prisma.$transaction(async (tx) =>
      tx.notificationRecipient.updateMany({
        where: {
          tenantId: user.tenantId,
          recipientType: NOTIFICATION_RECIPIENT_TYPES.USER,
          recipientId: user.id,
          readAt: null,
          archivedAt: null,
          deletedAt: null,
          notification: { tenantId: user.tenantId, deletedAt: null },
        },
        data: { readAt: new Date(), version: { increment: 1 } },
      }),
    );

    await this.publishUnreadCount(user);
    return { updated: result.count };
  }

  async archive(user: AuthenticatedUser, notificationId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const recipient = await this.findOwnedRecipient(tx, user, notificationId);
      if (!recipient) throw new EntityNotFoundError('Notification', notificationId);

      if (!recipient.archivedAt) {
        await tx.notificationRecipient.update({
          where: { id: recipient.id },
          data: { archivedAt: new Date(), version: { increment: 1 } },
        });
      }
    });

    await this.publishUnreadCount(user);
  }

  private recipientScope(
    user: AuthenticatedUser,
    query: ListNotificationsQueryDto,
  ): NotificationRecipientScope {
    return {
      tenantId: user.tenantId,
      recipientType: NOTIFICATION_RECIPIENT_TYPES.USER,
      recipientId: user.id,
      deletedAt: null,
      ...(query.includeArchived ? {} : { archivedAt: null }),
      ...(query.unreadOnly ? { readAt: null } : {}),
    };
  }

  private findOwnedRecipient(
    database: Prisma.TransactionClient,
    user: AuthenticatedUser,
    notificationId: string,
  ) {
    return database.notificationRecipient.findFirst({
      where: {
        tenantId: user.tenantId,
        recipientType: NOTIFICATION_RECIPIENT_TYPES.USER,
        recipientId: user.id,
        notificationId,
        deletedAt: null,
        notification: { tenantId: user.tenantId, deletedAt: null },
      },
      select: { id: true, readAt: true, archivedAt: true },
    });
  }

  private toItem(
    notification: {
      id: string;
      type: string;
      severity: string;
      title: string;
      body: string;
      entityType: string | null;
      entityId: string | null;
      data: Prisma.JsonValue;
      createdAt: Date;
    },
    recipient: { readAt: Date | null; archivedAt: Date | null },
  ): NotificationItemDto {
    const data = toJsonRecord(notification.data);
    return {
      id: notification.id,
      type: notification.type,
      severity: notification.severity,
      title: notification.title,
      body: notification.body,
      entityType: notification.entityType,
      entityId: notification.entityId,
      link: resolveNotificationLink(
        notification.entityType,
        notification.entityId,
        data,
      ),
      data,
      createdAt: notification.createdAt.toISOString(),
      readAt: recipient.readAt?.toISOString() ?? null,
      archivedAt: recipient.archivedAt?.toISOString() ?? null,
    };
  }

  private async publishUnreadCount(user: AuthenticatedUser): Promise<void> {
    const { count } = await this.unreadCount(user);
    try {
      this.gateway.emitUnreadCount(user.tenantId, user.id, count);
    } catch (error) {
      this.logger.warn({
        tenantId: user.tenantId,
        userId: user.id,
        message:
          error instanceof Error
            ? error.message
            : 'Không thể đồng bộ số thông báo chưa đọc',
      });
    }
  }
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(
    JSON.stringify({ createdAt: createdAt.toISOString(), id }),
  ).toString('base64url');
}

function decodeCursor(value: string): NotificationCursor {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid cursor encoding');
    const parsed: unknown = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    );
    if (!parsed || typeof parsed !== 'object') throw new Error('Invalid cursor');

    const cursor = parsed as { createdAt?: unknown; id?: unknown };
    if (typeof cursor.createdAt !== 'string' || typeof cursor.id !== 'string') {
      throw new Error('Invalid cursor fields');
    }

    const createdAt = new Date(cursor.createdAt);
    if (Number.isNaN(createdAt.getTime()) || !isUuid(cursor.id)) {
      throw new Error('Invalid cursor values');
    }
    return { createdAt, id: cursor.id };
  } catch {
    throw new ValidationError('Cursor phân trang không hợp lệ');
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}
