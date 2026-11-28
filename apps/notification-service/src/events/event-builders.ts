import { z } from 'zod';
import {
  deliveryResultEventSchema,
  tripDispatchedEventV2Schema,
  type DomainEventEnvelope,
} from '@logix/messaging';
import { ServiceId } from '@logix/common';
import {
  NOTIFICATION_AUDIENCE_PERMISSIONS,
  NOTIFICATION_ENTITY_TYPES,
  NOTIFICATION_SEVERITIES,
  NOTIFICATION_TYPES,
} from '../notifications/notification.constants.js';
import {
  renderDeliveryCompletedTemplate,
  renderDeliveryFailedTemplate,
  renderOrderPendingStockTemplate,
  renderTripDispatchedTemplate,
} from '../notifications/notification-templates.js';
import type { NotificationDraft } from './notification-draft.js';

const uuid = z.string().uuid();

const orderPendingStockPayloadSchema = z
  .object({
    orderId: uuid,
    warehouseId: uuid,
    pendingSince: z.string().datetime({ offset: true }),
    shortageItems: z
      .array(
        z
          .object({
            productId: uuid,
            requestedQuantity: z.string().min(1),
            availableQuantity: z.string().min(1),
          })
          .strict(),
      )
      .nonempty(),
  })
  .strict();

const orderPendingStockEventSchema = z
  .object({
    eventId: uuid,
    eventType: z.literal('OrderPendingStock'),
    eventVersion: z.literal(1),
    occurredAt: z.string().datetime({ offset: true }),
    producer: z.literal(ServiceId.ORDER_SERVICE),
    tenantId: uuid,
    actorId: uuid.nullable(),
    correlationId: uuid,
    causationId: uuid,
    aggregateType: z.literal('SalesOrder'),
    aggregateId: uuid,
    aggregateVersion: z.number().int().nonnegative(),
    payload: orderPendingStockPayloadSchema,
  })
  .strict()
  .superRefine((event, context) => {
    if (event.payload.orderId !== event.aggregateId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['payload', 'orderId'],
        message: 'Payload order identity must match the event aggregate',
      });
    }
  });

interface EventBuilderEntry {
  parseAndBuild: (event: DomainEventEnvelope) => NotificationDraft;
}

function defineEventBuilder<T>(
  schema: z.ZodType<T>,
  build: (parsed: T) => NotificationDraft,
): EventBuilderEntry {
  return {
    parseAndBuild: (event) => build(schema.parse(event)),
  };
}

const EVENT_BUILDERS: Record<string, EventBuilderEntry> = {
  OrderPendingStock: defineEventBuilder(orderPendingStockEventSchema, (parsed) => ({
    ...renderOrderPendingStockTemplate(parsed.payload.orderId),
    type: NOTIFICATION_TYPES.ORDER_PENDING_STOCK,
    severity: NOTIFICATION_SEVERITIES.WARNING,
    entityType: NOTIFICATION_ENTITY_TYPES.SALES_ORDER,
    entityId: parsed.payload.orderId,
    deduplicationKey: `OrderPendingStock:${parsed.payload.orderId}:${parsed.aggregateVersion}`,
    data: { ...parsed.payload },
    audience: {
      kind: 'PERMISSION',
      code: NOTIFICATION_AUDIENCE_PERMISSIONS.ORDER_PENDING_STOCK,
    },
  })),

  TripDispatched: defineEventBuilder(tripDispatchedEventV2Schema, (parsed) => ({
    ...renderTripDispatchedTemplate(parsed.payload.tripId),
    type: NOTIFICATION_TYPES.TRIP_DISPATCHED,
    severity: NOTIFICATION_SEVERITIES.INFO,
    entityType: NOTIFICATION_ENTITY_TYPES.DELIVERY_TRIP,
    entityId: parsed.payload.tripId,
    deduplicationKey: `TripDispatched:${parsed.payload.tripId}:${parsed.payload.dispatchVersion}`,
    data: { ...parsed.payload },
    audience: {
      kind: 'USERS',
      userIds: [parsed.payload.assigneeUserId],
    },
  })),

  DeliveryFailed: defineEventBuilder(deliveryResultEventSchema, (parsed) => ({
    ...renderDeliveryFailedTemplate(parsed.payload.stopId),
    type: NOTIFICATION_TYPES.DELIVERY_FAILED,
    severity: NOTIFICATION_SEVERITIES.CRITICAL,
    entityType: NOTIFICATION_ENTITY_TYPES.DELIVERY_TRIP,
    entityId: parsed.payload.tripId,
    deduplicationKey: `DeliveryFailed:${parsed.payload.stopId}:${parsed.payload.attempt}`,
    data: { ...parsed.payload },
    audience: {
      kind: 'PERMISSION',
      code: NOTIFICATION_AUDIENCE_PERMISSIONS.DELIVERY_FAILED,
    },
  })),

  DeliveryCompleted: defineEventBuilder(deliveryResultEventSchema, (parsed) => ({
    ...renderDeliveryCompletedTemplate(parsed.payload.stopId),
    type: NOTIFICATION_TYPES.DELIVERY_COMPLETED,
    severity: NOTIFICATION_SEVERITIES.INFO,
    entityType: NOTIFICATION_ENTITY_TYPES.DELIVERY_TRIP,
    entityId: parsed.payload.tripId,
    deduplicationKey: `DeliveryCompleted:${parsed.payload.stopId}:${parsed.payload.attempt}`,
    data: { ...parsed.payload },
    audience: {
      kind: 'PERMISSION',
      code: NOTIFICATION_AUDIENCE_PERMISSIONS.DELIVERY_COMPLETED,
    },
  })),
};

export const SUPPORTED_NOTIFICATION_EVENT_TYPES = Object.keys(EVENT_BUILDERS);

export class InvalidNotificationEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidNotificationEventError';
  }
}

function assertTenantAndEvent(event: DomainEventEnvelope): void {
  if (!uuid.safeParse(event.tenantId).success || !uuid.safeParse(event.eventId).success) {
    throw new InvalidNotificationEventError('Notification event identities are invalid');
  }
}

export function buildNotificationDraft(
  event: DomainEventEnvelope,
): NotificationDraft | null {
  const builder = Object.hasOwn(EVENT_BUILDERS, event.eventType)
    ? EVENT_BUILDERS[event.eventType]
    : undefined;
  if (!builder) {
    return null;
  }

  assertTenantAndEvent(event);
  return builder.parseAndBuild(event);
}
