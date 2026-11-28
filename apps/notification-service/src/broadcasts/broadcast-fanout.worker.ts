import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { DomainEventEnvelope } from '@logix/messaging';
import { PrismaService } from '../database/prisma.service.js';
import { InAppDeliveryWorker } from '../deliveries/in-app-delivery.worker.js';
import { IdentityRecipientClient } from '../integrations/identity-recipient.client.js';
import {
  BROADCAST_COMMAND_EVENT_TYPE,
  BROADCAST_ERROR_CODES,
  BROADCAST_STATUSES,
  DEFAULT_BROADCAST_FANOUT_BATCH_SIZE,
  DEFAULT_MAX_BROADCAST_RECIPIENTS,
} from '../notifications/notification.constants.js';
import { NotificationWriterService } from '../notifications/notification-writer.service.js';
import { broadcastCommandPayloadSchema } from './broadcast.types.js';

export type BroadcastFanoutResult =
  | { outcome: 'IGNORED' | 'INVALID' | 'SKIPPED' }
  | { outcome: 'FAILED'; reason: string }
  | { outcome: 'READY'; resolvedCount: number };

@Injectable()
export class BroadcastFanoutWorker {
  private readonly logger = new Logger(BroadcastFanoutWorker.name);
  private readonly maxRecipients: number;
  private readonly fanoutBatchSize: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly recipients: IdentityRecipientClient,
    private readonly writer: NotificationWriterService,
    config: ConfigService,
    @Optional() private readonly deliveryWorker?: InAppDeliveryWorker,
  ) {
    this.maxRecipients =
      config.get<number>('MAX_BROADCAST_RECIPIENTS') ??
      DEFAULT_MAX_BROADCAST_RECIPIENTS;
    this.fanoutBatchSize =
      config.get<number>('BROADCAST_FANOUT_BATCH_SIZE') ??
      DEFAULT_BROADCAST_FANOUT_BATCH_SIZE;
  }

  async handle(event: DomainEventEnvelope): Promise<BroadcastFanoutResult> {
    if (
      event.eventType !== BROADCAST_COMMAND_EVENT_TYPE ||
      event.eventVersion !== 1
    ) {
      return { outcome: 'IGNORED' };
    }

    const parsed = broadcastCommandPayloadSchema.safeParse(event.payload);
    if (!parsed.success || parsed.data.tenantId !== event.tenantId) {
      this.logger.warn({
        eventId: event.eventId,
        tenantId: event.tenantId,
        correlationId: event.correlationId,
        message: 'Invalid broadcast command payload',
      });
      return { outcome: 'INVALID' };
    }

    const command = parsed.data;

    const claimed = await this.prisma.$transaction(async (tx) =>
      tx.notificationBroadcast.updateMany({
        where: {
          id: command.broadcastId,
          tenantId: command.tenantId,
          deletedAt: null,
          status: {
            in: [BROADCAST_STATUSES.QUEUED, BROADCAST_STATUSES.FANOUTING],
          },
        },
        data: {
          status: BROADCAST_STATUSES.FANOUTING,
          version: { increment: 1 },
        },
      }),
    );

    if (claimed.count === 0) {
      return { outcome: 'SKIPPED' };
    }

    const collected = new Set<string>();
    let cursor: string | null = null;
    let hasMore = false;

    do {
      const page = await this.recipients.resolvePage(
        command.tenantId,
        command.audience,
        {
          limit: this.fanoutBatchSize,
          cursor,
          snapshotAt: command.snapshotAt,
        },
      );

      for (const userId of page.userIds) {
        collected.add(userId);
      }

      if (
        collected.size > this.maxRecipients ||
        (collected.size === this.maxRecipients && page.hasMore)
      ) {
        await this.markFailed(
          command.broadcastId,
          command.tenantId,
          BROADCAST_ERROR_CODES.MAX_RECIPIENTS_EXCEEDED,
        );
        this.logger.warn({
          tenantId: command.tenantId,
          broadcastId: command.broadcastId,
          notificationId: command.notificationId,
          status: BROADCAST_STATUSES.FAILED,
          errorCode: BROADCAST_ERROR_CODES.MAX_RECIPIENTS_EXCEEDED,
        });
        return {
          outcome: 'FAILED',
          reason: BROADCAST_ERROR_CODES.MAX_RECIPIENTS_EXCEEDED,
        };
      }

      hasMore = page.hasMore;
      if (hasMore) {
        if (!page.nextCursor || page.nextCursor === cursor) {
          throw new Error('Identity recipient pagination cursor did not advance');
        }
        cursor = page.nextCursor;
      }
    } while (hasMore);

    const resolvedUserIds = [...collected];
    if (resolvedUserIds.length === 0) {
      await this.markFailed(
        command.broadcastId,
        command.tenantId,
        BROADCAST_ERROR_CODES.NO_RECIPIENTS,
      );
      this.logger.warn({
        tenantId: command.tenantId,
        broadcastId: command.broadcastId,
        notificationId: command.notificationId,
        status: BROADCAST_STATUSES.FAILED,
        errorCode: BROADCAST_ERROR_CODES.NO_RECIPIENTS,
      });
      return {
        outcome: 'FAILED',
        reason: BROADCAST_ERROR_CODES.NO_RECIPIENTS,
      };
    }

    for (
      let offset = 0;
      offset < resolvedUserIds.length;
      offset += this.fanoutBatchSize
    ) {
      const chunk = resolvedUserIds.slice(
        offset,
        offset + this.fanoutBatchSize,
      );
      const availableAt = new Date();
      await this.prisma.$transaction(async (tx) =>
        this.writer.attachInAppRecipientsBatch(tx, {
          tenantId: command.tenantId,
          notificationId: command.notificationId,
          recipientUserIds: chunk,
          availableAt,
        }),
      );
    }

    await this.prisma.notificationBroadcast.updateMany({
      where: {
        id: command.broadcastId,
        tenantId: command.tenantId,
        deletedAt: null,
      },
      data: {
        status: BROADCAST_STATUSES.READY,
        resolvedCount: resolvedUserIds.length,
        lastError: null,
        version: { increment: 1 },
      },
    });

    this.deliveryWorker?.wakeUp();

    this.logger.log({
      tenantId: command.tenantId,
      broadcastId: command.broadcastId,
      notificationId: command.notificationId,
      recipientCount: resolvedUserIds.length,
      status: BROADCAST_STATUSES.READY,
      correlationId: event.correlationId,
    });

    return {
      outcome: 'READY',
      resolvedCount: resolvedUserIds.length,
    };
  }

  private async markFailed(
    broadcastId: string,
    tenantId: string,
    reason: string,
  ): Promise<void> {
    await this.prisma.notificationBroadcast.updateMany({
      where: {
        id: broadcastId,
        tenantId,
        deletedAt: null,
      },
      data: {
        status: BROADCAST_STATUSES.FAILED,
        resolvedCount: 0,
        completedAt: new Date(),
        lastError: reason,
        version: { increment: 1 },
      },
    });
  }
}
