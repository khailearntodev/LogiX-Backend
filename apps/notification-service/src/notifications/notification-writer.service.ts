import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '../generated/prisma/client.js';
import {
  NOTIFICATION_DELIVERY_STATUSES,
  NOTIFICATION_RECIPIENT_TYPES,
  type NotificationSeverity,
} from './notification.constants.js';
import { NOTIFICATION_CHANNELS } from './notification.types.js';

export interface CreateNotificationRecordInput {
  id?: string;
  tenantId: string;
  type: string;
  title: string;
  body: string;
  severity: NotificationSeverity;
  entityType: string | null;
  entityId: string | null;
  sourceEventId: string | null;
  deduplicationKey: string | null;
  link: string | null;
  data: Record<string, unknown>;
}

export interface AttachInAppRecipientsInput {
  tenantId: string;
  notificationId: string;
  recipientUserIds: string[];
  availableAt: Date;
}

@Injectable()
export class NotificationWriterService {
  async createNotification(
    tx: Prisma.TransactionClient,
    input: CreateNotificationRecordInput,
  ): Promise<{ id: string; createdAt: Date }> {
    const id = input.id ?? randomUUID();
    return tx.notification.create({
      data: {
        id,
        tenantId: input.tenantId,
        type: input.type,
        title: input.title,
        body: input.body,
        severity: input.severity,
        entityType: input.entityType,
        entityId: input.entityId,
        sourceEventId: input.sourceEventId,
        deduplicationKey: input.deduplicationKey,
        data: {
          ...input.data,
          ...(input.link ? { link: input.link } : {}),
        } as Prisma.InputJsonValue,
      },
      select: { id: true, createdAt: true },
    });
  }

  async attachInAppRecipientsBatch(
    tx: Prisma.TransactionClient,
    input: AttachInAppRecipientsInput,
  ): Promise<{ recipientCount: number; deliveryCount: number }> {
    const uniqueUserIds = [...new Set(input.recipientUserIds)];
    if (uniqueUserIds.length === 0) {
      return { recipientCount: 0, deliveryCount: 0 };
    }

    const recipients = uniqueUserIds.map((recipientId) => ({
      id: randomUUID(),
      tenantId: input.tenantId,
      notificationId: input.notificationId,
      recipientType: NOTIFICATION_RECIPIENT_TYPES.USER,
      recipientId,
    }));

    const recipientResult = await tx.notificationRecipient.createMany({
      data: recipients,
      skipDuplicates: true,
    });

    const persistedRecipients = await tx.notificationRecipient.findMany({
      where: {
        tenantId: input.tenantId,
        notificationId: input.notificationId,
        recipientType: NOTIFICATION_RECIPIENT_TYPES.USER,
        recipientId: { in: uniqueUserIds },
        deletedAt: null,
      },
      select: { id: true },
    });

    const recipientRowIds =
      persistedRecipients.length > 0
        ? persistedRecipients.map((row) => row.id)
        : recipients.map((row) => row.id);

    const deliveryResult = await tx.notificationDelivery.createMany({
      data: recipientRowIds.map((notificationRecipientId) => ({
        id: randomUUID(),
        notificationRecipientId,
        channel: NOTIFICATION_CHANNELS.IN_APP,
        status: NOTIFICATION_DELIVERY_STATUSES.PENDING,
        attemptCount: 0,
        nextAttemptAt: input.availableAt,
      })),
      skipDuplicates: true,
    });

    return {
      recipientCount: recipientResult.count,
      deliveryCount: deliveryResult.count,
    };
  }
}
