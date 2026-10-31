import { randomUUID } from 'node:crypto';
import { ServiceId } from '@logix/common';
import type { PrismaService } from '../database/prisma.service.js';
import { ShipmentCanceledConsumer } from './shipment-canceled.consumer.js';
import type { TripMembershipService } from './trip-membership.service.js';

describe('ShipmentCanceled Kafka consumer', () => {
  it('fails malformed cancellation payloads before writing Inbox state', async () => {
    const transaction = vi.fn();
    const consumer = new ShipmentCanceledConsumer(
      { $transaction: transaction } as unknown as PrismaService,
      {} as TripMembershipService,
    );
    const event = {
      eventId: randomUUID(),
      eventType: 'ShipmentCanceled',
      eventVersion: 1,
      occurredAt: new Date().toISOString(),
      producer: ServiceId.FULFILLMENT_SERVICE,
      tenantId: randomUUID(),
      actorId: null,
      correlationId: randomUUID(),
      causationId: randomUUID(),
      aggregateType: 'Shipment',
      aggregateId: randomUUID(),
      aggregateVersion: 4,
      payload: { shipmentId: randomUUID() },
    };

    await expect(consumer.handle(event)).rejects.toThrow();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('records an applied Inbox event, invalidates the trip, and resumes a durable release', async () => {
    const tenantId = randomUUID();
    const tripId = randomUUID();
    const shipmentId = randomUUID();
    const actorId = randomUUID();
    const claimId = randomUUID();
    const eventId = randomUUID();
    const membership = {
      id: randomUUID(),
      tenantId,
      tripId,
      shipmentId,
      state: 'ACTIVE',
      shipmentVersion: 4n,
      claimReceipt: { claimId, tripVersion: 3 },
      claimRequest: { actorId },
    };
    const trip = { id: tripId, version: 3n, status: 'APPROVED' };
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      tripDispatch: { findFirst: vi.fn().mockResolvedValue(null) },
      inboxEvent: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: randomUUID() }),
      },
      tripShipment: {
        findFirst: vi.fn().mockResolvedValue(membership),
        update: vi.fn().mockResolvedValue({ ...membership, state: 'RELEASE_PENDING' }),
        findMany: vi.fn().mockResolvedValue([]),
      },
      deliveryTrip: {
        findFirst: vi.fn().mockResolvedValue(trip),
        update: vi.fn().mockResolvedValue({ ...trip, version: 4n }),
      },
      tripOperation: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: randomUUID() }),
      },
      tripStop: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      routePlan: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const prisma = {
      inboxEvent: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: unknown) => Promise<unknown>) =>
        callback(tx),
      ),
    } as unknown as PrismaService;
    const resume = vi.fn().mockResolvedValue(undefined);
    const consumer = new ShipmentCanceledConsumer(
      prisma,
      { resume } as unknown as TripMembershipService,
    );
    const event = {
      eventId,
      eventType: 'ShipmentCanceled',
      eventVersion: 1,
      occurredAt: new Date().toISOString(),
      producer: ServiceId.FULFILLMENT_SERVICE,
      tenantId,
      actorId: null,
      correlationId: randomUUID(),
      causationId: randomUUID(),
      aggregateType: 'Shipment',
      aggregateId: shipmentId,
      aggregateVersion: 5,
      payload: {
        shipmentId,
        orderId: randomUUID(),
        reservationGroupId: randomUUID(),
        warehouseId: randomUUID(),
        dispatchRequestId: randomUUID(),
        reason: 'ORDER_CANCELED',
      },
    };

    await consumer.handle(event);

    expect(tx.tripOperation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId,
        tripId,
        requestId: eventId,
        kind: 'SHIPMENT_CANCELED',
        status: 'PENDING',
      }),
    });
    expect(tx.tripShipment.update).toHaveBeenCalledWith({
      where: { id: membership.id },
      data: expect.objectContaining({
        state: 'RELEASE_PENDING',
        releaseRequest: expect.objectContaining({
          tenantId,
          tripId,
          shipmentId,
          actorId,
          expectedTripVersion: 4,
          expectedShipmentVersion: 5,
          reason: 'SHIPMENT_CANCELED',
        }),
      }),
    });
    expect(tx.deliveryTrip.update).toHaveBeenCalledWith({
      where: { id: tripId },
      data: expect.objectContaining({
        approvedRoutePlanId: null,
        version: { increment: 1 },
      }),
    });
    expect(tx.routePlan.updateMany).not.toHaveBeenCalled();
    expect(tx.inboxEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventId,
        outcome: 'APPLIED',
        aggregateVersion: 5n,
      }),
    });
    expect(resume).toHaveBeenCalledExactlyOnceWith(
      expect.any(String),
      true,
    );
  });
});
