import { Injectable, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../database/prisma.service.js';
import { InAppDeliveryWorker } from '../deliveries/in-app-delivery.worker.js';
import {
  NOTIFICATION_CONSUMER_NAME,
  NOTIFICATION_INBOX_OUTCOMES,
  type NotificationInboxOutcome,
} from '../notifications/notification.constants.js';
import { NotificationWriterService } from '../notifications/notification-writer.service.js';
import { IdentityRecipientClient } from '../integrations/identity-recipient.client.js';
import type { DomainEventEnvelope } from '@logix/messaging';
import type { NotificationDraft } from './notification-draft.js';
import {
  InvalidNotificationEventError,
  buildNotificationDraft,
} from './event-builders.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type NotificationProcessOutcome = NotificationInboxOutcome | 'IGNORED';

export interface NotificationProcessResult {
  outcome: NotificationProcessOutcome;
  notificationId?: string;
  recipientUserIds?: string[];
}

type PersistResult =
  | { outcome: 'DUPLICATE' | 'NO_RECIPIENTS' }
  | { outcome: 'APPLIED'; notificationId: string; createdAt: Date };

@Injectable()
export class NotificationProcessor {
  private readonly logger = new Logger(NotificationProcessor.name);

  private readonly writer: NotificationWriterService;

  constructor(
    private readonly prisma: PrismaService,
    private readonly recipients: IdentityRecipientClient,
    @Optional() private readonly deliveryWorker?: InAppDeliveryWorker,
    @Optional() writer?: NotificationWriterService,
  ) {
    this.writer = writer ?? new NotificationWriterService();
  }

  async handle(event: DomainEventEnvelope): Promise<NotificationProcessResult> {
    let draft: NotificationDraft | null;
    try {
      draft = buildNotificationDraft(event);
    } catch (error) {
      if (
        !(error instanceof ZodError) &&
        !(error instanceof InvalidNotificationEventError)
      ) {
        throw error;
      }
      if (this.canRecordInbox(event)) {
        await this.recordInbox(
          event,
          NOTIFICATION_INBOX_OUTCOMES.REJECTED_INVALID,
          'INVALID_EVENT',
        );
      } else {
        this.logger.warn({
          eventId: event.eventId,
          eventType: event.eventType,
          message: 'Invalid notification event could not be persisted to inbox',
        });
      }
      return { outcome: NOTIFICATION_INBOX_OUTCOMES.REJECTED_INVALID };
    }

    if (!draft) {
      return { outcome: 'IGNORED' };
    }

    const existing = await this.prisma.inboxEvent.findUnique({
      where: {
        consumerName_eventId: {
          consumerName: NOTIFICATION_CONSUMER_NAME,
          eventId: event.eventId,
        },
      },
    });
    if (existing) {
      return { outcome: NOTIFICATION_INBOX_OUTCOMES.DUPLICATE };
    }

    const recipientUserIds = await this.recipients.resolve(
      event.tenantId,
      draft.audience,
    );
    const result = await this.persist(event, draft, recipientUserIds);

    if (result.outcome !== NOTIFICATION_INBOX_OUTCOMES.APPLIED) {
      return { outcome: result.outcome, recipientUserIds };
    }

    this.deliveryWorker?.wakeUp();

    return {
      outcome: result.outcome,
      notificationId: result.notificationId,
      recipientUserIds,
    };
  }

  private async persist(
    event: DomainEventEnvelope,
    draft: NotificationDraft,
    recipientUserIds: string[],
  ): Promise<PersistResult> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const existing = await tx.inboxEvent.findUnique({
          where: {
            consumerName_eventId: {
              consumerName: NOTIFICATION_CONSUMER_NAME,
              eventId: event.eventId,
            },
          },
        });
        if (existing) {
          return { outcome: NOTIFICATION_INBOX_OUTCOMES.DUPLICATE };
        }

        if (recipientUserIds.length === 0) {
          await tx.inboxEvent.create({
            data: this.inboxData(event, NOTIFICATION_INBOX_OUTCOMES.NO_RECIPIENTS),
          });
          return { outcome: NOTIFICATION_INBOX_OUTCOMES.NO_RECIPIENTS };
        }

        const created = await this.writer.createNotification(tx, {
          tenantId: event.tenantId,
          type: draft.type,
          title: draft.title,
          body: draft.body,
          severity: draft.severity,
          entityType: draft.entityType,
          entityId: draft.entityId,
          sourceEventId: event.eventId,
          deduplicationKey: draft.deduplicationKey,
          link: draft.link,
          data: draft.data,
        });

        await this.writer.attachInAppRecipientsBatch(tx, {
          tenantId: event.tenantId,
          notificationId: created.id,
          recipientUserIds,
          availableAt: created.createdAt,
        });
        await tx.inboxEvent.create({
          data: this.inboxData(event, NOTIFICATION_INBOX_OUTCOMES.APPLIED),
        });

        return {
          outcome: NOTIFICATION_INBOX_OUTCOMES.APPLIED,
          notificationId: created.id,
          createdAt: created.createdAt,
        };
      });
    } catch (error) {
      if (!this.isDuplicateConstraintViolation(error)) throw error;
      await this.recordInbox(
        event,
        NOTIFICATION_INBOX_OUTCOMES.DUPLICATE,
        'DUPLICATE_EVENT',
      );
      return { outcome: NOTIFICATION_INBOX_OUTCOMES.DUPLICATE };
    }
  }

  private async recordInbox(
    event: DomainEventEnvelope,
    outcome: 'REJECTED_INVALID' | 'DUPLICATE',
    errorCode: string,
  ): Promise<void> {
    await this.prisma.inboxEvent.upsert({
      where: {
        consumerName_eventId: {
          consumerName: NOTIFICATION_CONSUMER_NAME,
          eventId: event.eventId,
        },
      },
      create: this.inboxData(event, outcome, errorCode),
      update: {},
    });
  }

  private canRecordInbox(event: DomainEventEnvelope): boolean {
    return (
      [event.eventId, event.tenantId, event.aggregateId].every(
        (value) => typeof value === 'string' && UUID_PATTERN.test(value),
      ) && Number.isSafeInteger(event.aggregateVersion)
    );
  }

  private inboxData(
    event: DomainEventEnvelope,
    outcome: NotificationInboxOutcome,
    errorCode?: string,
  ) {
    return {
      id: randomUUID(),
      tenantId: event.tenantId,
      eventId: event.eventId,
      consumerName: NOTIFICATION_CONSUMER_NAME,
      eventType: event.eventType,
      aggregateId: event.aggregateId,
      aggregateVersion: BigInt(event.aggregateVersion),
      outcome,
      errorCode,
    };
  }

  private isDuplicateConstraintViolation(error: unknown): boolean {
    if (
      !(error instanceof Prisma.PrismaClientKnownRequestError) ||
      error.code !== 'P2002'
    ) {
      return false;
    }

    const meta = error.meta as Record<string, unknown> | undefined;
    if (!meta) return false;

    const target = meta.target;
    if (typeof target === 'string' && DUPLICATE_INDEX_NAMES.has(target)) {
      return true;
    }

    const driverError = meta.driverAdapterError as Record<string, unknown> | undefined;
    const cause = driverError?.cause as Record<string, unknown> | undefined;
    const constraint = cause?.constraint as Record<string, unknown> | undefined;
    const indexName = constraint?.index;
    if (typeof indexName === 'string' && DUPLICATE_INDEX_NAMES.has(indexName)) {
      return true;
    }

    const rawFields = Array.isArray(target)
      ? target
      : Array.isArray(constraint?.fields)
        ? constraint.fields
        : [];
    const fields = new Set(
      rawFields.filter((value): value is string => typeof value === 'string'),
    );

    return (
      hasAllFields(fields, [
        ['consumer_name', 'consumerName'],
        ['event_id', 'eventId'],
      ]) ||
      hasAllFields(fields, [
        ['tenant_id', 'tenantId'],
        ['deduplication_key', 'deduplicationKey'],
      ])
    );
  }
}

const DUPLICATE_INDEX_NAMES = new Set([
  'ux_inbox_consumer_event',
  'ux_notification_event_recipient_scope',
]);

function hasAllFields(
  fields: ReadonlySet<string>,
  pairs: readonly [string, string][],
): boolean {
  return pairs.every(([snake, camel]) => fields.has(snake) || fields.has(camel));
}
