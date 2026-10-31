import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ServiceId } from '@logix/common';
import {
  deliveryResultEventSchema,
  type DeliveryResultPayload,
  type DomainEventEnvelope,
} from '@logix/messaging';
import { PrismaService } from '../database/prisma.service.js';
import { ShipmentDeliveryEventsService } from './shipment-delivery-events.service.js';

function setup() {
  const tenantId = randomUUID();
  const tripId = randomUUID();
  const stopId = randomUUID();
  const shipmentId = randomUUID();
  const requestId = randomUUID();
  const driverId = randomUUID();
  const assigneeUserId = randomUUID();
  const actorId = randomUUID();
  const now = new Date().toISOString();
  const shipment = {
    id: shipmentId,
    tenantId,
    assignedTripId: tripId,
    status: 'DISPATCHED',
    orderId: randomUUID(),
    warehouseId: randomUUID(),
    reservationGroupId: randomUUID(),
    version: 4n,
  };
  const inbox: Record<string, unknown>[] = [];
  const tx = {
    $queryRaw: vi.fn(),
    inboxEvent: {
      findUnique: vi.fn(
        async ({
          where,
        }: {
          where: {
            consumerName_eventId: { consumerName: string; eventId: string };
          };
        }) =>
          inbox.find(
            (row) =>
              row.consumerName === where.consumerName_eventId.consumerName &&
              row.eventId === where.consumerName_eventId.eventId,
          ) ?? null,
      ),
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where: {
            consumerName: string;
            tenantId: string;
            semanticKey: string;
          };
        }) =>
          inbox.find(
            (row) =>
              row.consumerName === where.consumerName &&
              row.tenantId === where.tenantId &&
              row.semanticKey === where.semanticKey,
          ) ?? null,
      ),
      findMany: vi.fn(async () =>
        inbox.filter((row) => row.outcome === 'DEFERRED'),
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: randomUUID(), ...data };
        inbox.push(row);
        return row;
      }),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          const row = inbox.find((item) => item.id === where.id);
          if (!row) throw new Error('Inbox row missing');
          Object.assign(row, data);
          return row;
        },
      ),
    },
    shipment: {
      findFirst: vi.fn(async () => shipment),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(shipment, data);
        if (
          typeof data.version === 'object' &&
          data.version !== null &&
          'increment' in data.version
        ) {
          shipment.version += BigInt(
            (data.version as { increment: number }).increment,
          );
        }
        return shipment;
      }),
    },
    shipmentStatusHistory: { create: vi.fn() },
    outboxEvent: { create: vi.fn() },
  };
  const prisma = {
    ...tx,
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<void>) =>
      fn(tx),
    ),
  };
  const event: DomainEventEnvelope<DeliveryResultPayload> = {
    eventId: randomUUID(),
    eventType: 'DeliveryCompleted',
    eventVersion: 2,
    occurredAt: now,
    tenantId,
    actorId,
    producer: ServiceId.TRANSPORT_SERVICE,
    correlationId: randomUUID(),
    causationId: randomUUID(),
    aggregateType: 'DeliveryTrip',
    aggregateId: tripId,
    aggregateVersion: 5,
    payload: {
      contractVersion: 1,
      tenantId,
      tripId,
      stopId,
      shipmentId,
      attempt: 1,
      driverId,
      assigneeUserId,
      outcome: 'DELIVERED',
      occurredAt: now,
      reason: null,
      requestId,
    },
  };
  deliveryResultEventSchema.parse(event);
  return {
    inbox,
    shipment,
    tx,
    prisma,
    event,
    service: new ShipmentDeliveryEventsService(
      prisma as unknown as PrismaService,
    ),
    stopId,
  };
}

describe('Shipment delivery result projection', () => {
  it('durably defers an early result and applies it after the shipment dispatch projection arrives', async () => {
    const s = setup();
    s.shipment.status = 'READY_TO_SHIP';

    await s.service.handle(s.event);

    expect(s.inbox[0]).toMatchObject({
      outcome: 'DEFERRED',
      eventId: s.event.eventId,
      eventPayload: s.event,
    });
    expect(s.tx.shipment.update).not.toHaveBeenCalled();

    s.shipment.status = 'DISPATCHED';
    await s.service.retryDeferred();

    expect(s.shipment.status).toBe('DELIVERED');
    expect(s.tx.shipmentStatusHistory.create).toHaveBeenCalledOnce();
    expect(s.tx.outboxEvent.create).toHaveBeenCalledOnce();
    expect(s.inbox[0]).toMatchObject({ outcome: 'APPLIED' });
  });

  it('treats a semantically identical event with a different event id as a duplicate', async () => {
    const s = setup();
    await s.service.handle(s.event);
    await s.service.handle({ ...s.event, eventId: randomUUID() });

    expect(s.shipment.status).toBe('DELIVERED');
    expect(s.tx.shipment.update).toHaveBeenCalledOnce();
    expect(s.tx.outboxEvent.create).toHaveBeenCalledOnce();
    expect(s.inbox[1]).toMatchObject({ outcome: 'DUPLICATE' });
  });

  it('records conflicting terminal outcomes without overwriting the shipment', async () => {
    const s = setup();
    await s.service.handle(s.event);
    const conflicting = {
      ...s.event,
      eventId: randomUUID(),
      eventType: 'DeliveryFailed',
      payload: {
        ...s.event.payload,
        outcome: 'FAILED',
        reason: 'Recipient unavailable',
      },
    } as DomainEventEnvelope;

    await s.service.handle(conflicting);

    expect(s.shipment.status).toBe('DELIVERED');
    expect(s.tx.shipment.update).toHaveBeenCalledOnce();
    expect(s.inbox[1]).toMatchObject({
      outcome: 'CONFLICT',
      errorCode: 'CONFLICTING_TERMINAL_RESULT',
    });
  });

  it('does not apply either result when conflicting terminal results arrive before dispatch projection', async () => {
    const s = setup();
    s.shipment.status = 'READY_TO_SHIP';
    await s.service.handle(s.event);
    await s.service.handle({
      ...s.event,
      eventId: randomUUID(),
      eventType: 'DeliveryFailed',
      payload: {
        ...s.event.payload,
        outcome: 'FAILED',
        reason: 'Recipient unavailable',
      },
    } as DomainEventEnvelope);

    s.shipment.status = 'DISPATCHED';
    await s.service.retryDeferred();

    expect(s.shipment.status).toBe('DISPATCHED');
    expect(s.tx.shipment.update).not.toHaveBeenCalled();
    expect(s.inbox.map((row) => row.outcome)).toEqual(['CONFLICT', 'CONFLICT']);
  });

  it('rejects reuse of an event id with a changed payload', async () => {
    const s = setup();
    await s.service.handle(s.event);

    await expect(
      s.service.handle({
        ...s.event,
        payload: { ...s.event.payload, driverId: randomUUID() },
      }),
    ).rejects.toThrow('Delivery result event id payload conflict');
    expect(s.tx.shipment.update).toHaveBeenCalledOnce();
  });

  it('rethrows a transient transaction failure so Kafka cannot acknowledge unpersisted work', async () => {
    const s = setup();
    s.prisma.$transaction.mockRejectedValueOnce(
      new Error('database unavailable'),
    );

    await expect(s.service.handle(s.event)).rejects.toThrow(
      'database unavailable',
    );
    expect(s.inbox).toHaveLength(0);

    await s.service.handle(s.event);

    expect(s.shipment.status).toBe('DELIVERED');
    expect(s.inbox[0]).toMatchObject({ outcome: 'APPLIED' });
  });

  it('rejects a non-canonical result or mismatched aggregate binding', async () => {
    const s = setup();
    await expect(
      s.service.handle({ ...s.event, producer: ServiceId.ORDER_SERVICE }),
    ).rejects.toThrow();
    await expect(
      s.service.handle({
        ...s.event,
        aggregateId: randomUUID(),
      }),
    ).rejects.toThrow();
    await expect(
      s.service.handle({
        ...s.event,
        payload: { ...s.event.payload, unexpected: true },
      }),
    ).rejects.toThrow();

    expect(s.tx.shipment.update).not.toHaveBeenCalled();
    expect(s.tx.outboxEvent.create).not.toHaveBeenCalled();
  });

  it('does not project a result onto a shipment assigned to another trip', async () => {
    const s = setup();
    s.shipment.assignedTripId = randomUUID();

    await s.service.handle(s.event);

    expect(s.shipment.status).toBe('DISPATCHED');
    expect(s.tx.shipment.update).not.toHaveBeenCalled();
    expect(s.inbox[0]).toMatchObject({
      outcome: 'CONFLICT',
      errorCode: 'TRIP_SHIPMENT_BINDING_MISMATCH',
    });
  });
});
