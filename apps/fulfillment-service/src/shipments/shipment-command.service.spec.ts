import { randomUUID } from 'node:crypto';
import { SHIPMENT_EVENT as E, SHIPMENT_STATUS as S } from '@logix/messaging';
import { describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../database/prisma.service.js';
import { ShipmentCommandService } from './shipment-command.service.js';
import { ShipmentQueryService } from './shipment-query.service.js';

function setup(status: string = S.PENDING_PICK, pending = false) {
  const ctx = {
    tenantId: randomUUID(),
    actorId: randomUUID(),
    correlationId: randomUUID(),
  };
  const shipment = {
    id: randomUUID(),
    tenantId: ctx.tenantId,
    warehouseId: randomUUID(),
    orderId: randomUUID(),
    reservationGroupId: randomUUID(),
    version: 1n,
    status,
    dispatchIntent: pending ? { status: 'PENDING' } : null,
  };
  const tx = {
    $queryRaw: vi.fn(),
    shipment: {
      findFirst: vi.fn(async () => shipment),
      update: vi.fn(async ({ data }) => ({
        ...shipment,
        ...data,
        version: 2n,
      })),
    },
    shipmentStatusHistory: { create: vi.fn() },
    outboxEvent: { create: vi.fn() },
  };
  const prisma = {
    $transaction: vi.fn(
      async (action: (transaction: typeof tx) => Promise<void>) => action(tx),
    ),
  };
  const queries = { detail: vi.fn(async () => shipment) };
  return {
    ctx,
    shipment,
    tx,
    queries,
    command: new ShipmentCommandService(
      prisma as unknown as PrismaService,
      queries as unknown as ShipmentQueryService,
    ),
  };
}

describe('Shipment pick/pack command', () => {
  it.each([
    [S.PENDING_PICK, S.PICKING, E.PICKING],
    [S.PICKING, S.READY_TO_SHIP, E.READY],
  ])(
    'writes one atomic transition %s -> %s then reads authoritative detail',
    async (from, to, eventType) => {
      const f = setup(from);
      await f.command.transition(f.shipment.id, 1, to, f.ctx);
      expect(f.tx.$queryRaw).toHaveBeenCalledOnce();
      expect(f.tx.shipment.update).toHaveBeenCalledWith({
        where: { id: f.shipment.id, tenantId: f.ctx.tenantId },
        data: {
          status: to,
          version: { increment: 1 },
          ...(to === S.READY_TO_SHIP && { readyAt: expect.any(Date) }),
        },
      });
      expect(f.tx.shipmentStatusHistory.create).toHaveBeenCalledExactlyOnceWith(
        {
          data: expect.objectContaining({
            tenantId: f.ctx.tenantId,
            fromStatus: from,
            toStatus: to,
            shipmentVersion: 2n,
            actorId: f.ctx.actorId,
            correlationId: f.ctx.correlationId,
          }),
        },
      );
      expect(f.tx.outboxEvent.create).toHaveBeenCalledExactlyOnceWith({
        data: expect.objectContaining({
          eventType,
          aggregateVersion: 2n,
          aggregateId: f.shipment.id,
          tenantId: f.ctx.tenantId,
        }),
      });
      expect(f.queries.detail).toHaveBeenCalledExactlyOnceWith(
        f.ctx.tenantId,
        f.shipment.id,
      );
      expect(f.tx.outboxEvent.create.mock.invocationCallOrder[0]).toBeLessThan(
        f.queries.detail.mock.invocationCallOrder[0],
      );
    },
  );

  it.each([
    [S.PENDING_PICK, false, 2, 'SHIPMENT_VERSION_CONFLICT'],
    [S.PICKING, false, 1, 'SHIPMENT_INVALID_TRANSITION'],
    [S.CANCELED, false, 1, 'SHIPMENT_INVALID_TRANSITION'],
    [S.PENDING_PICK, true, 1, 'SHIPMENT_DISPATCH_PENDING'],
  ] as const)(
    'rejects %s/pending=%s/version=%s without writes',
    async (status, pending, version, reason) => {
      const f = setup(status, pending);
      await expect(
        f.command.transition(f.shipment.id, version, S.PICKING, f.ctx),
      ).rejects.toMatchObject({ httpStatus: 409, reason });
      expect(f.tx.shipment.update).not.toHaveBeenCalled();
      expect(f.tx.shipmentStatusHistory.create).not.toHaveBeenCalled();
      expect(f.tx.outboxEvent.create).not.toHaveBeenCalled();
      expect(f.queries.detail).not.toHaveBeenCalled();
    },
  );

  it.each(['history', 'outbox'] as const)(
    'propagates %s failures without returning success',
    async (failure) => {
      const f = setup();
      const write =
        failure === 'history'
          ? f.tx.shipmentStatusHistory.create
          : f.tx.outboxEvent.create;
      write.mockRejectedValueOnce(new Error('QA transaction write failed'));
      await expect(
        f.command.transition(f.shipment.id, 1, S.PICKING, f.ctx),
      ).rejects.toThrow('QA transaction write failed');
      expect(f.queries.detail).not.toHaveBeenCalled();
    },
  );
});
