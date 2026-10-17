import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../database/prisma.service.js';
import { OrderClient, OrderRequestRejected } from './order.client.js';
import { ShipmentQueryService } from './shipment-query.service.js';
import { ShipmentDispatchService } from './shipment-dispatch.service.js';

function setup() {
  const ctx = {
    tenantId: randomUUID(),
    actorId: randomUUID(),
    correlationId: randomUUID(),
  };
  const dto = {
    requestId: randomUUID(),
    version: 3,
    orderVersion: 8,
    confirmed: true,
  };
  const shipment = {
    id: randomUUID(),
    tenantId: ctx.tenantId,
    orderId: randomUUID(),
    reservationGroupId: randomUUID(),
    warehouseId: randomUUID(),
    status: 'READY_TO_SHIP',
    version: 3n,
    dispatchIntent: null as Record<string, unknown> | null,
  };
  const tx = {
    $queryRaw: vi.fn(),
    shipment: {
      findFirst: vi.fn(async () => shipment),
      findFirstOrThrow: vi.fn(async () => shipment),
      update: vi.fn(async ({ data }) => ({
        ...shipment,
        ...data,
        version: shipment.version + 1n,
      })),
    },
    shipmentDispatchIntent: {
      create: vi.fn(async ({ data }) => {
        shipment.dispatchIntent = data;
      }),
      update: vi.fn(async ({ data }) => {
        Object.assign(shipment.dispatchIntent!, data);
      }),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
    shipmentStatusHistory: { create: vi.fn() },
    outboxEvent: { create: vi.fn() },
  };
  const prisma = {
    ...tx,
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) =>
      fn(tx),
    ),
  };
  const orders = {
    snapshot: vi.fn(async () => ({
      id: shipment.orderId,
      status: 'READY_TO_SHIP',
      version: 8,
      cancellationRequestedAt: null,
      reservationGroupId: shipment.reservationGroupId,
    })),
    authorize: vi.fn(async (_id, body, context) => ({
      ...body,
      orderId: shipment.orderId,
      correlationId: context.correlationId,
      grantedAt: new Date().toISOString(),
    })),
  };
  const queries = { detail: vi.fn(async () => shipment) };
  const service = new ShipmentDispatchService(
    prisma as unknown as PrismaService,
    orders as unknown as OrderClient,
    queries as unknown as ShipmentQueryService,
  );
  return { ctx, dto, shipment, tx, orders, queries, service };
}
describe('Persisted shipment dispatch', () => {
  it('rejects guessed future Order versions before persisting a recoverable intent', async () => {
    const s = setup();
    await expect(
      s.service.dispatch(s.shipment.id, { ...s.dto, orderVersion: 9 }, s.ctx),
    ).rejects.toMatchObject({ httpStatus: 409 });
    expect(s.tx.shipmentDispatchIntent.create).not.toHaveBeenCalled();
    expect(s.orders.authorize).not.toHaveBeenCalled();
  });
  it('persists exact intent before HTTP then atomically writes status/history/outbox', async () => {
    const s = setup();
    await s.service.dispatch(s.shipment.id, s.dto, s.ctx);
    expect(
      s.tx.shipmentDispatchIntent.create.mock.invocationCallOrder[0],
    ).toBeLessThan(s.orders.authorize.mock.invocationCallOrder[0]!);
    expect(s.tx.shipment.update.mock.calls[0]?.[0].data).toMatchObject({
      status: 'DISPATCHED',
      version: { increment: 1 },
    });
    expect(s.tx.outboxEvent.create.mock.calls[0]?.[0].data).toMatchObject({
      eventType: 'ShipmentDispatched',
      payload: { dispatchRequestId: s.dto.requestId },
    });
  });
  it('keeps intent pending on unknown outcome and recovers with identical content', async () => {
    const s = setup();
    s.orders.authorize.mockRejectedValueOnce(new Error('timeout'));
    await expect(
      s.service.dispatch(s.shipment.id, s.dto, s.ctx),
    ).rejects.toThrow('timeout');
    expect(s.shipment.dispatchIntent?.status).toBe('PENDING');
    expect(s.tx.outboxEvent.create).not.toHaveBeenCalled();
    await s.service.complete(s.ctx.tenantId, s.shipment.id);
    expect(s.orders.authorize.mock.calls[0]).toEqual(
      s.orders.authorize.mock.calls[1],
    );
    expect(s.shipment.dispatchIntent?.status).toBe('COMPLETED');
  });
  it('does not emit again after completion', async () => {
    const s = setup();
    await s.service.dispatch(s.shipment.id, s.dto, s.ctx);
    await s.service.complete(s.ctx.tenantId, s.shipment.id);
    expect(s.tx.outboxEvent.create).toHaveBeenCalledOnce();
  });
  it('marks only definitive 409 as rejected', async () => {
    const s = setup();
    s.orders.authorize.mockRejectedValueOnce(new OrderRequestRejected(409));
    await expect(
      s.service.dispatch(s.shipment.id, s.dto, s.ctx),
    ).rejects.toMatchObject({ httpStatus: 409 });
    expect(s.tx.shipmentDispatchIntent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'REJECTED' }),
      }),
    );
  });
  it.each([401, 403, 404, 500])(
    'does not discard a decision on upstream %s',
    async (status) => {
      const s = setup();
      s.orders.authorize.mockRejectedValueOnce(
        new OrderRequestRejected(status),
      );
      await expect(
        s.service.dispatch(s.shipment.id, s.dto, s.ctx),
      ).rejects.toThrow();
      expect(s.tx.shipmentDispatchIntent.updateMany).not.toHaveBeenCalled();
    },
  );
  it('rejects a changed request using the same ID', async () => {
    const s = setup();
    s.orders.authorize.mockRejectedValueOnce(new Error('timeout'));
    await expect(
      s.service.dispatch(s.shipment.id, s.dto, s.ctx),
    ).rejects.toThrow();
    await expect(
      s.service.dispatch(s.shipment.id, { ...s.dto, orderVersion: 9 }, s.ctx),
    ).rejects.toMatchObject({ httpStatus: 409 });
  });
  it('rejects replacing an unresolved intent', async () => {
    const s = setup();
    s.orders.authorize.mockRejectedValueOnce(new Error('timeout'));
    await expect(
      s.service.dispatch(s.shipment.id, s.dto, s.ctx),
    ).rejects.toThrow();
    await expect(
      s.service.dispatch(
        s.shipment.id,
        { ...s.dto, requestId: randomUUID() },
        s.ctx,
      ),
    ).rejects.toMatchObject({ httpStatus: 409 });
  });
  it('rejects mismatched grant without committing dispatch', async () => {
    const s = setup();
    s.orders.authorize.mockImplementationOnce(async (_id, body, context) => ({
      ...body,
      shipmentId: randomUUID(),
      orderId: s.shipment.orderId,
      correlationId: context.correlationId,
      grantedAt: new Date().toISOString(),
    }));
    await expect(
      s.service.dispatch(s.shipment.id, s.dto, s.ctx),
    ).rejects.toThrow('mismatched');
    expect(s.tx.outboxEvent.create).not.toHaveBeenCalled();
  });
  it('binds preview to shipment/order versions', async () => {
    const s = setup();
    expect(await s.service.preview(s.shipment.id, s.ctx)).toMatchObject({
      version: 3,
      orderVersion: 8,
    });
  });
  it('refuses preview before Order projection catches up', async () => {
    const s = setup();
    s.orders.snapshot.mockResolvedValueOnce({
      id: s.shipment.orderId,
      status: 'PICKING',
      version: 7,
      cancellationRequestedAt: null,
      reservationGroupId: s.shipment.reservationGroupId,
    });
    await expect(s.service.preview(s.shipment.id, s.ctx)).rejects.toMatchObject(
      { httpStatus: 409 },
    );
  });
});
