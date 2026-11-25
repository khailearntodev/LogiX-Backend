import { randomUUID } from 'node:crypto';
import { ServiceId } from '@logix/common';
import { TRANSPORT_PERMISSIONS } from '@logix/auth';
import { buildNotificationDraft } from './event-builders.js';

const id = () => randomUUID();

describe('buildNotificationDraft', () => {
  it('builds a permission-targeted OrderPendingStock notification', () => {
    const orderId = id();
    const event = {
      eventId: id(),
      eventType: 'OrderPendingStock',
      eventVersion: 1,
      occurredAt: new Date().toISOString(),
      producer: ServiceId.ORDER_SERVICE,
      tenantId: id(),
      actorId: null,
      correlationId: id(),
      causationId: id(),
      aggregateType: 'SalesOrder',
      aggregateId: orderId,
      aggregateVersion: 4,
      payload: {
        orderId,
        warehouseId: id(),
        pendingSince: new Date().toISOString(),
        shortageItems: [{ productId: id(), requestedQuantity: '2', availableQuantity: '1' }],
      },
    };

    expect(buildNotificationDraft(event)).toMatchObject({
      type: 'ORDER_PENDING_STOCK',
      severity: 'WARNING',
      entityType: 'SalesOrder',
      entityId: orderId,
      link: `/orders/${orderId}`,
      deduplicationKey: `OrderPendingStock:${orderId}:4`,
      audience: { kind: 'PERMISSION', code: 'order:sales-order:read' },
    });
  });

  it('builds a driver-targeted TripDispatched notification', () => {
    const tripId = id();
    const assigneeUserId = id();
    const event = {
      eventId: id(),
      eventType: 'TripDispatched',
      eventVersion: 2,
      occurredAt: new Date().toISOString(),
      producer: ServiceId.TRANSPORT_SERVICE,
      tenantId: id(),
      actorId: id(),
      correlationId: id(),
      causationId: id(),
      aggregateType: 'DeliveryTrip',
      aggregateId: tripId,
      aggregateVersion: 2,
      payload: {
        contractVersion: 1,
        tenantId: '',
        tripId,
        warehouseId: id(),
        approvedPlanId: id(),
        dispatchRequestId: id(),
        dispatchVersion: 3,
        driverId: id(),
        assigneeUserId,
        vehicleId: id(),
        dispatchedAt: new Date().toISOString(),
        shipments: [
          {
            shipmentId: id(),
            orderId: id(),
            reservationGroupId: id(),
            orderVersion: 1,
          },
        ],
      },
    };
    event.payload.tenantId = event.tenantId;

    expect(buildNotificationDraft(event)).toMatchObject({
      type: 'TRIP_DISPATCHED',
      severity: 'INFO',
      entityType: 'DeliveryTrip',
      entityId: tripId,
      link: '/driver/trips',
      deduplicationKey: `TripDispatched:${tripId}:3`,
      audience: { kind: 'USERS', userIds: [assigneeUserId] },
    });
  });

  it('builds a dispatcher-targeted DeliveryFailed notification with bounded deduplicationKey', () => {
    const tenantId = id();
    const tripId = id();
    const stopId = id();
    const event = {
      eventId: id(),
      eventType: 'DeliveryFailed',
      eventVersion: 2,
      occurredAt: new Date().toISOString(),
      producer: ServiceId.TRANSPORT_SERVICE,
      tenantId,
      actorId: id(),
      correlationId: id(),
      causationId: id(),
      aggregateType: 'DeliveryTrip',
      aggregateId: tripId,
      aggregateVersion: 5,
      payload: {
        contractVersion: 1,
        tenantId,
        tripId,
        stopId,
        shipmentId: id(),
        attempt: 2,
        driverId: id(),
        assigneeUserId: id(),
        outcome: 'FAILED',
        occurredAt: new Date().toISOString(),
        reason: 'Khách không nghe máy',
        requestId: id(),
      },
    };

    const draft = buildNotificationDraft(event);
    expect(draft).toMatchObject({
      type: 'DELIVERY_FAILED',
      severity: 'CRITICAL',
      entityType: 'DeliveryTrip',
      entityId: tripId,
      link: '/transport',
      deduplicationKey: `DeliveryFailed:${stopId}:2`,
      audience: { kind: 'PERMISSION', code: TRANSPORT_PERMISSIONS.TRIP_DISPATCH },
    });
    expect(draft!.deduplicationKey.length).toBeLessThanOrEqual(100);
  });

  it('builds a dispatcher-targeted DeliveryCompleted notification', () => {
    const tenantId = id();
    const tripId = id();
    const stopId = id();
    const event = {
      eventId: id(),
      eventType: 'DeliveryCompleted',
      eventVersion: 2,
      occurredAt: new Date().toISOString(),
      producer: ServiceId.TRANSPORT_SERVICE,
      tenantId,
      actorId: id(),
      correlationId: id(),
      causationId: id(),
      aggregateType: 'DeliveryTrip',
      aggregateId: tripId,
      aggregateVersion: 6,
      payload: {
        contractVersion: 1,
        tenantId,
        tripId,
        stopId,
        shipmentId: id(),
        attempt: 1,
        driverId: id(),
        assigneeUserId: id(),
        outcome: 'DELIVERED',
        occurredAt: new Date().toISOString(),
        reason: null,
        requestId: id(),
      },
    };

    const draft = buildNotificationDraft(event);
    expect(draft).toMatchObject({
      type: 'DELIVERY_COMPLETED',
      severity: 'INFO',
      entityType: 'DeliveryTrip',
      entityId: tripId,
      link: '/transport',
      deduplicationKey: `DeliveryCompleted:${stopId}:1`,
      audience: { kind: 'PERMISSION', code: TRANSPORT_PERMISSIONS.TRIP_DISPATCH },
    });
  });

  it('ignores an unsupported event type without validating identities', () => {
    expect(
      buildNotificationDraft({
        eventId: 'not-a-uuid',
        eventType: 'OrderCreated',
        eventVersion: 1,
        occurredAt: new Date().toISOString(),
        producer: ServiceId.ORDER_SERVICE,
        tenantId: 'not-a-uuid',
        actorId: null,
        correlationId: id(),
        causationId: id(),
        aggregateType: 'SalesOrder',
        aggregateId: id(),
        aggregateVersion: 1,
        payload: {},
      }),
    ).toBeNull();
  });

  it('throws when OrderPendingStock payload orderId mismatches aggregateId', () => {
    const event = {
      eventId: id(),
      eventType: 'OrderPendingStock',
      eventVersion: 1,
      occurredAt: new Date().toISOString(),
      producer: ServiceId.ORDER_SERVICE,
      tenantId: id(),
      actorId: null,
      correlationId: id(),
      causationId: id(),
      aggregateType: 'SalesOrder',
      aggregateId: id(),
      aggregateVersion: 1,
      payload: {
        orderId: id(),
        warehouseId: id(),
        pendingSince: new Date().toISOString(),
        shortageItems: [{ productId: id(), requestedQuantity: '2', availableQuantity: '1' }],
      },
    };

    expect(() => buildNotificationDraft(event)).toThrow();
  });

  it('throws when DeliveryFailed outcome does not match eventType', () => {
    const tenantId = id();
    const tripId = id();
    const event = {
      eventId: id(),
      eventType: 'DeliveryFailed',
      eventVersion: 2,
      occurredAt: new Date().toISOString(),
      producer: ServiceId.TRANSPORT_SERVICE,
      tenantId,
      actorId: id(),
      correlationId: id(),
      causationId: id(),
      aggregateType: 'DeliveryTrip',
      aggregateId: tripId,
      aggregateVersion: 2,
      payload: {
        contractVersion: 1,
        tenantId,
        tripId,
        stopId: id(),
        shipmentId: id(),
        attempt: 1,
        driverId: id(),
        assigneeUserId: id(),
        outcome: 'DELIVERED',
        occurredAt: new Date().toISOString(),
        reason: null,
        requestId: id(),
      },
    };

    expect(() => buildNotificationDraft(event)).toThrow();
  });
});
