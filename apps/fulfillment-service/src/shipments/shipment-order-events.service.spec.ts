import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ServiceId } from '@logix/common';
import type { DomainEventEnvelope } from '@logix/messaging';
import { PrismaService } from '../database/prisma.service.js';
import { OrderClient } from './order.client.js';
import { ShipmentOrderEventsService } from './shipment-order-events.service.js';

function setup() {
  const tenantId = randomUUID(),
    orderId = randomUUID(),
    customerId = randomUUID(),
    addressId = randomUUID(),
    warehouseId = randomUUID();
  const line = {
    orderLineId: randomUUID(),
    lineNumber: 1,
    productId: randomUUID(),
    quantity: '10.000',
    skuSnapshot: 'QA',
    productNameSnapshot: 'QA immutable product',
    unitSnapshot: 'PCS',
    unitWeight: '1.000',
    unitVolume: '0.010000',
  };
  const payload = {
    orderId,
    orderNumber: 'QA-001',
    orderVersion: 2,
    reservationGroupId: randomUUID(),
    confirmedAt: new Date().toISOString(),
    customerId,
    deliveryAddressId: addressId,
    warehouseId,
    customerSnapshot: { customerId, code: 'QA-C', name: 'QA customer' },
    deliveryAddressSnapshot: {
      addressId,
      addressType: 'SHIPPING',
      addressLine: 'QA address',
    },
    warehouseSnapshot: { warehouseId, code: 'QA-W', name: 'QA warehouse' },
    orderLines: [line],
    totalQuantity: '10.000',
    totalWeight: '10.000',
    totalVolume: '0.100000',
  };
  const event: DomainEventEnvelope = {
    eventId: randomUUID(),
    eventType: 'OrderConfirmed',
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
    tenantId,
    actorId: null,
    producer: ServiceId.ORDER_SERVICE,
    correlationId: randomUUID(),
    causationId: randomUUID(),
    aggregateType: 'SalesOrder',
    aggregateId: orderId,
    aggregateVersion: 2,
    payload,
  };
  const tx = {
    $queryRaw: vi.fn(),
    inboxEvent: { findUnique: vi.fn(), create: vi.fn() },
    shipmentOrderCursor: { findUnique: vi.fn(), upsert: vi.fn() },
    shipment: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      create: vi.fn(async ({ data }) => ({
        ...data,
        id: randomUUID(),
        version: 1n,
      })),
      update: vi.fn(),
    },
    shipmentStatusHistory: { create: vi.fn() },
    shipmentDispatchIntent: { updateMany: vi.fn() },
    outboxEvent: { create: vi.fn() },
  };
  const prisma = {
    ...tx,
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<void>) =>
      fn(tx),
    ),
  };
  const orders = {
    snapshot: vi.fn(async () => ({
      id: orderId,
      reservationGroupId: payload.reservationGroupId,
      lines: [{ ...line, id: line.orderLineId }],
    })),
  };
  return {
    tx,
    line,
    payload,
    event,
    orders,
    service: new ShipmentOrderEventsService(
      prisma as unknown as PrismaService,
      orders as unknown as OrderClient,
    ),
  };
}
describe('Shipment pool source events', () => {
  it('copies snapshots/line totals and writes creation history/outbox/inbox in one transaction', async () => {
    const s = setup();
    await s.service.handle(s.event);
    const data = s.tx.shipment.create.mock.calls[0]![0].data;
    expect(data.customerSnapshot).toEqual(s.payload.customerSnapshot);
    expect(data.deliveryAddressSnapshot).toEqual(
      s.payload.deliveryAddressSnapshot,
    );
    expect(data.warehouseSnapshot).toEqual(s.payload.warehouseSnapshot);
    expect(data.items.create[0].weight.toString()).toBe('10');
    expect(s.orders.snapshot).not.toHaveBeenCalled();
    expect(s.tx.outboxEvent.create).toHaveBeenCalledOnce();
  });
  it('retrieves only missing legacy line snapshots from protected Order API', async () => {
    const s = setup();
    const { orderLineId, lineNumber, productId, quantity } = s.line;
    await s.service.handle({
      ...s.event,
      payload: {
        ...s.payload,
        orderLines: [{ orderLineId, lineNumber, productId, quantity }],
      },
    });
    expect(s.orders.snapshot).toHaveBeenCalledOnce();
    expect(
      s.tx.shipment.create.mock.calls[0]![0].data.items.create[0]
        .productNameSnapshot,
    ).toBe('QA immutable product');
  });
  it('does not repair malformed rich events through a fallback', async () => {
    const s = setup();
    await expect(
      s.service.handle({
        ...s.event,
        payload: {
          ...s.payload,
          orderLines: [{ ...s.line, unitWeight: 'invalid' }],
        },
      }),
    ).rejects.toThrow();
    expect(s.orders.snapshot).not.toHaveBeenCalled();
  });
  it('deduplicates event IDs', async () => {
    const s = setup();
    s.tx.inboxEvent.findUnique.mockResolvedValue({});
    await s.service.handle(s.event);
    expect(s.tx.shipment.create).not.toHaveBeenCalled();
  });
  it('does not reparse a removed QA event already recorded in the inbox', async () => {
    const s = setup();
    s.tx.inboxEvent.findUnique.mockResolvedValue({
      outcome: 'IGNORED_QA_CLEANUP',
      errorCode: 'REMOVED_QA_SOURCE',
    });
    await s.service.handle({
      ...s.event,
      payload: {
        ...s.payload,
        customerSnapshot: {},
        deliveryAddressSnapshot: {},
        warehouseSnapshot: {},
      },
    });
    expect(s.orders.snapshot).not.toHaveBeenCalled();
    expect(s.tx.shipment.create).not.toHaveBeenCalled();
    expect(s.tx.inboxEvent.create).not.toHaveBeenCalled();
    expect(s.tx.outboxEvent.create).not.toHaveBeenCalled();
  });
  it('still rejects malformed header snapshots without an inbox record', async () => {
    const s = setup();
    await expect(
      s.service.handle({
        ...s.event,
        payload: {
          ...s.payload,
          customerSnapshot: {},
          deliveryAddressSnapshot: {},
          warehouseSnapshot: {},
        },
      }),
    ).rejects.toThrow();
    expect(s.orders.snapshot).not.toHaveBeenCalled();
    expect(s.tx.shipment.create).not.toHaveBeenCalled();
    expect(s.tx.inboxEvent.create).not.toHaveBeenCalled();
    expect(s.tx.outboxEvent.create).not.toHaveBeenCalled();
  });
  it('prevents resurrection after cancellation-before-confirmation', async () => {
    const s = setup();
    s.tx.shipmentOrderCursor.findUnique.mockResolvedValue({
      orderVersion: 9n,
      canceled: true,
    });
    await s.service.handle(s.event);
    expect(s.tx.shipment.create).not.toHaveBeenCalled();
    expect(s.tx.inboxEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ outcome: 'IGNORED_STALE' }),
      }),
    );
  });
  it('deduplicates order/version with a different event ID', async () => {
    const s = setup();
    s.tx.shipmentOrderCursor.findUnique.mockResolvedValue({
      orderVersion: 2n,
      canceled: false,
    });
    await s.service.handle(s.event);
    expect(s.tx.shipment.create).not.toHaveBeenCalled();
  });
  it('does not create a second shipment for the same order', async () => {
    const s = setup();
    s.tx.shipment.findUnique.mockResolvedValue({
      reservationGroupId: s.payload.reservationGroupId,
    });
    await s.service.handle(s.event);
    expect(s.tx.shipment.create).not.toHaveBeenCalled();
  });
  it('rejects another reservation for an existing shipment', async () => {
    const s = setup();
    s.tx.shipment.findUnique.mockResolvedValue({
      reservationGroupId: randomUUID(),
    });
    await expect(s.service.handle(s.event)).rejects.toThrow('another shipment');
  });
  it('saves a cancellation tombstone when no shipment exists', async () => {
    const s = setup();
    await s.service.handle({
      ...s.event,
      eventType: 'OrderCanceled',
      aggregateVersion: 3,
      payload: {
        orderId: s.payload.orderId,
        reason: 'QA cancel',
        canceledAt: new Date().toISOString(),
      },
    });
    expect(s.tx.shipmentOrderCursor.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ canceled: true, orderVersion: 3n }),
      }),
    );
  });
  it('ignores a late legacy confirmation after cancellation even if Order is unavailable', async () => {
    const s = setup();
    s.tx.shipmentOrderCursor.findUnique.mockResolvedValue({
      orderVersion: 9n,
      canceled: true,
    });
    const { orderLineId, lineNumber, productId, quantity } = s.line;
    await s.service.handle({
      ...s.event,
      payload: {
        ...s.payload,
        orderLines: [{ orderLineId, lineNumber, productId, quantity }],
      },
    });
    expect(s.orders.snapshot).not.toHaveBeenCalled();
    expect(s.tx.shipment.create).not.toHaveBeenCalled();
  });
  it('rejects snapshot identity mismatch', async () => {
    const s = setup();
    await expect(
      s.service.handle({
        ...s.event,
        payload: { ...s.payload, warehouseId: randomUUID() },
      }),
    ).rejects.toThrow('snapshots mismatch');
  });
  it('rejects confirmation version mismatch', async () => {
    const s = setup();
    await expect(
      s.service.handle({ ...s.event, aggregateVersion: 3 }),
    ).rejects.toThrow('version mismatch');
  });
  it('rejects legacy snapshot that changed product', async () => {
    const s = setup();
    s.orders.snapshot.mockResolvedValueOnce({
      id: s.payload.orderId,
      reservationGroupId: s.payload.reservationGroupId,
      lines: [{ ...s.line, id: s.line.orderLineId, productId: randomUUID() }],
    });
    const { orderLineId, lineNumber, productId, quantity } = s.line;
    await expect(
      s.service.handle({
        ...s.event,
        payload: {
          ...s.payload,
          orderLines: [{ orderLineId, lineNumber, productId, quantity }],
        },
      }),
    ).rejects.toThrow('line mismatch');
  });
});
