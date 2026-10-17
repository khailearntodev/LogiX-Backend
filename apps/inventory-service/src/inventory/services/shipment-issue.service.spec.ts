import { randomUUID } from 'node:crypto';
import { ServiceId } from '@logix/common';
import type { DomainEventEnvelope } from '@logix/messaging';
import { PrismaService } from '../../database/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import { StockMovementService } from './stock-movement.service.js';
import { ShipmentIssueService } from './shipment-issue.service.js';

function setup() {
  const payload = {
    shipmentId: randomUUID(),
    orderId: randomUUID(),
    warehouseId: randomUUID(),
    reservationGroupId: randomUUID(),
    dispatchRequestId: randomUUID(),
    reason: null,
  };
  const event: DomainEventEnvelope = {
    eventId: randomUUID(),
    eventType: 'ShipmentDispatched',
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
    tenantId: randomUUID(),
    producer: ServiceId.FULFILLMENT_SERVICE,
    actorId: randomUUID(),
    correlationId: randomUUID(),
    causationId: randomUUID(),
    aggregateType: 'Shipment',
    aggregateId: payload.shipmentId,
    aggregateVersion: 4,
    payload,
  };
  const productId = randomUUID();
  const line = {
    tenantId: event.tenantId,
    orderId: payload.orderId,
    warehouseId: payload.warehouseId,
    productId,
    status: 'ACTIVE',
    quantity: new Prisma.Decimal(3),
  };
  const group = {
    id: payload.reservationGroupId,
    status: 'ACTIVE',
    issueShipmentId: null as string | null,
    issueRequestId: null as string | null,
    reservations: [line, { ...line, quantity: new Prisma.Decimal(2) }],
  };
  const tx = {
    $queryRaw: vi.fn(),
    inboxEvent: { findUnique: vi.fn(), create: vi.fn() },
    reservationGroup: { findFirst: vi.fn(async () => group), update: vi.fn() },
    inventoryReservation: { updateMany: vi.fn() },
    stockMovement: { findFirst: vi.fn() },
    inventoryBalance: {
      findFirstOrThrow: vi.fn(async () => ({
        id: randomUUID(),
        reservedQuantity: new Prisma.Decimal(10),
      })),
      update: vi.fn(),
    },
  };
  const prisma = {
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<void>) =>
      fn(tx),
    ),
  };
  const movement = { applyMovementInTransaction: vi.fn() };
  return {
    event,
    payload,
    group,
    tx,
    movement,
    service: new ShipmentIssueService(
      prisma as unknown as PrismaService,
      movement as unknown as StockMovementService,
    ),
  };
}
describe('Shipment ISSUE transaction', () => {
  it('aggregates same-product reservations, decrements reserved before sole on-hand primitive, persists receipt', async () => {
    const s = setup();
    await s.service.handle(s.event);
    expect(s.tx.inventoryBalance.update).toHaveBeenCalledOnce();
    expect(s.movement.applyMovementInTransaction).toHaveBeenCalledWith(
      s.tx,
      expect.objectContaining({
        movementType: 'ISSUE',
        quantityDelta: '-5.000',
        referenceId: s.payload.shipmentId,
        idempotencyKey: expect.stringMatching(/^shipment:.*:issue:/),
      }),
    );
    expect(
      s.tx.inventoryBalance.update.mock.invocationCallOrder[0],
    ).toBeLessThan(
      s.movement.applyMovementInTransaction.mock.invocationCallOrder[0]!,
    );
    expect(s.tx.reservationGroup.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'ISSUED',
          issueShipmentId: s.payload.shipmentId,
          issueRequestId: s.payload.dispatchRequestId,
        }),
      }),
    );
  });
  it('deduplicates same event', async () => {
    const s = setup();
    s.tx.inboxEvent.findUnique.mockResolvedValue({});
    await s.service.handle(s.event);
    expect(s.movement.applyMovementInTransaction).not.toHaveBeenCalled();
  });
  it('deduplicates business receipt with a new event ID', async () => {
    const s = setup();
    Object.assign(s.group, {
      status: 'ISSUED',
      issueShipmentId: s.payload.shipmentId,
      issueRequestId: s.payload.dispatchRequestId,
    });
    await s.service.handle(s.event);
    expect(s.movement.applyMovementInTransaction).not.toHaveBeenCalled();
    expect(s.tx.inboxEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ outcome: 'IGNORED_STALE' }),
      }),
    );
  });
  it('rejects issued reservation claimed by another shipment', async () => {
    const s = setup();
    Object.assign(s.group, {
      status: 'ISSUED',
      issueShipmentId: randomUUID(),
      issueRequestId: s.payload.dispatchRequestId,
    });
    await expect(s.service.handle(s.event)).rejects.toThrow('another dispatch');
  });
  it('rejects released reservation', async () => {
    const s = setup();
    s.group.status = 'RELEASED';
    await expect(s.service.handle(s.event)).rejects.toThrow('inactive');
  });
  it('rejects missing group without recording success', async () => {
    const s = setup();
    s.tx.reservationGroup.findFirst.mockResolvedValueOnce(null!);
    await expect(s.service.handle(s.event)).rejects.toThrow('unknown');
    expect(s.tx.inboxEvent.create).not.toHaveBeenCalled();
  });
  it('rejects corrupt reserved balance', async () => {
    const s = setup();
    s.tx.inventoryBalance.findFirstOrThrow.mockResolvedValueOnce({
      id: randomUUID(),
      reservedQuantity: new Prisma.Decimal(1),
    });
    await expect(s.service.handle(s.event)).rejects.toThrow('insufficient');
    expect(s.movement.applyMovementInTransaction).not.toHaveBeenCalled();
  });
  it('rejects movement without matching group receipt', async () => {
    const s = setup();
    s.tx.stockMovement.findFirst.mockResolvedValue({});
    await expect(s.service.handle(s.event)).rejects.toThrow('receipt');
  });
  it('rejects a cross-tenant reservation line', async () => {
    const s = setup();
    s.group.reservations[0]!.tenantId = randomUUID();
    await expect(s.service.handle(s.event)).rejects.toThrow('ownership');
  });
  it.each([null, 'bad'])('rejects invalid actor %s', async (actorId) => {
    const s = setup();
    await expect(s.service.handle({ ...s.event, actorId })).rejects.toThrow();
  });
});
