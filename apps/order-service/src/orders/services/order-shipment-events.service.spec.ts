import { randomUUID } from 'node:crypto';
import { ServiceId } from '@logix/common';
import type { DomainEventEnvelope } from '@logix/messaging';
import { PrismaService } from '../../database/prisma.service.js';
import { salesOrderFixture } from '../../../test/fixtures/order.fixtures.js';
import { OrderShipmentEventsService } from './order-shipment-events.service.js';

function setup() {
  const order = salesOrderFixture({
    status: 'CONFIRMED',
    reservationGroupId: randomUUID(),
  });
  const shipmentId = randomUUID();
  const event: DomainEventEnvelope = {
    eventId: randomUUID(),
    eventType: 'ShipmentPicking',
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
    tenantId: order.tenantId,
    producer: ServiceId.FULFILLMENT_SERVICE,
    actorId: null,
    correlationId: randomUUID(),
    causationId: randomUUID(),
    aggregateType: 'Shipment',
    aggregateId: shipmentId,
    aggregateVersion: 2,
    payload: {
      shipmentId,
      orderId: order.id,
      warehouseId: order.warehouseId,
      reservationGroupId: order.reservationGroupId,
      reason: null,
      dispatchRequestId: null,
    },
  };
  const tx = {
    $queryRaw: vi.fn(),
    salesOrder: {
      findFirst: vi.fn(async () => order),
      update: vi.fn(async () => ({ ...order, version: 2n })),
    },
    inboxEvent: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
    orderStatusHistory: { create: vi.fn() },
  };
  const prisma = {
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<void>) =>
      fn(tx),
    ),
  };
  return {
    event,
    order,
    tx,
    service: new OrderShipmentEventsService(prisma as unknown as PrismaService),
  };
}
describe('Shipment lifecycle projection', () => {
  it.each([
    ['ShipmentPicking', 'CONFIRMED', 'PICKING'],
    ['ShipmentReadyToShip', 'PICKING', 'READY_TO_SHIP'],
    ['ShipmentDelivered', 'IN_DELIVERY', 'COMPLETED'],
    ['ShipmentDeliveryFailed', 'IN_DELIVERY', 'DELIVERY_FAILED'],
  ])(
    'projects %s without emitting draft edits',
    async (eventType, from, to) => {
      const s = setup();
      s.order.status = from;
      await s.service.handle({ ...s.event, eventType });
      expect(s.tx.salesOrder.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: to,
            version: { increment: 1 },
          }),
        }),
      );
      expect(s.tx.inboxEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ outcome: 'APPLIED' }),
        }),
      );
    },
  );
  it.each([
    'DRAFT',
    'CANCELED',
    'COMPLETED',
    'DELIVERY_FAILED',
    'READY_TO_SHIP',
  ])('ignores invalid/stale event from %s', async (status) => {
    const s = setup();
    s.order.status = status;
    await s.service.handle(s.event);
    expect(s.tx.salesOrder.update).not.toHaveBeenCalled();
    expect(s.tx.inboxEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ outcome: 'IGNORED_STALE' }),
      }),
    );
  });
  it('deduplicates event ID', async () => {
    const s = setup();
    s.tx.inboxEvent.findUnique.mockResolvedValue({ id: randomUUID() });
    await s.service.handle(s.event);
    expect(s.tx.salesOrder.update).not.toHaveBeenCalled();
  });
  it('ignores older aggregate versions even with another event ID', async () => {
    const s = setup();
    s.tx.inboxEvent.findFirst.mockResolvedValue({ aggregateVersion: 9n });
    await s.service.handle(s.event);
    expect(s.tx.salesOrder.update).not.toHaveBeenCalled();
  });
  it('does not advance while cancellation is pending', async () => {
    const s = setup();
    s.order.cancellationRequestedAt = new Date();
    await s.service.handle(s.event);
    expect(s.tx.salesOrder.update).not.toHaveBeenCalled();
  });
  it('requires persisted dispatch arbitration', async () => {
    const s = setup();
    s.order.status = 'READY_TO_SHIP';
    await expect(
      s.service.handle({ ...s.event, eventType: 'ShipmentDispatched' }),
    ).rejects.toThrow('grant');
  });
  it('rejects unexpected producer', async () => {
    const s = setup();
    await expect(
      s.service.handle({ ...s.event, producer: ServiceId.ORDER_SERVICE }),
    ).rejects.toThrow();
  });
  it('rejects mismatched shipment identity', async () => {
    const s = setup();
    await expect(
      s.service.handle({ ...s.event, aggregateId: randomUUID() }),
    ).rejects.toThrow('aggregate');
  });
});
