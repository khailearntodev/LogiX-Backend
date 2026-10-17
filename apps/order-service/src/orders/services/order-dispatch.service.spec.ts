import { randomUUID } from 'node:crypto';
import type { AuthorizeOrderDispatchRequest } from '@logix/messaging';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import {
  salesOrderFixture,
  commandContext,
  TENANT_ID,
  ORDER_ID,
} from '../../../test/fixtures/order.fixtures.js';
import { ORDER_ERROR_REASON } from '../domain/order-errors.js';
import { OrderDispatchService } from './order-dispatch.service.js';

const request: AuthorizeOrderDispatchRequest = {
  requestId: randomUUID(),
  shipmentId: randomUUID(),
  reservationGroupId: randomUUID(),
  actorId: commandContext.actorId,
  orderVersion: 7,
};

function setup() {
  const order = salesOrderFixture({
    status: 'READY_TO_SHIP',
    version: 7n,
    reservationGroupId: request.reservationGroupId,
  });
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    salesOrder: {
      findFirst: vi.fn().mockResolvedValue(order),
      update: vi.fn().mockImplementation(async ({ data }) => ({
        ...order,
        ...data,
        version: 8n,
      })),
    },
  };
  const prisma = {
    $transaction: vi.fn(
      async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
    ),
  };
  return {
    tx,
    order,
    authorize: (override: Partial<AuthorizeOrderDispatchRequest> = {}) =>
      new OrderDispatchService(prisma as unknown as PrismaService).authorize(
        TENANT_ID,
        ORDER_ID,
        { ...request, ...override },
        commandContext.correlationId,
      ),
  };
}

describe('OrderDispatchService', () => {
  it('persists one decision under the same row lock used by cancellation without projecting status', async () => {
    const { tx, authorize } = setup();
    const grant = await authorize();
    expect(tx.$queryRaw).toHaveBeenCalledOnce();
    expect(tx.salesOrder.findFirst).toHaveBeenCalledWith({
      where: { id: ORDER_ID, tenantId: TENANT_ID, deletedAt: null },
    });
    expect(grant).toMatchObject({ ...request, orderId: ORDER_ID });
    expect(tx.salesOrder.update).toHaveBeenCalledWith({
      where: { id: ORDER_ID, tenantId: TENANT_ID },
      data: expect.objectContaining({
        dispatchRequestId: request.requestId,
        dispatchShipmentId: request.shipmentId,
        dispatchOrderVersion: 7n,
        version: { increment: 1 },
      }),
    });
    expect(tx.salesOrder.update.mock.calls[0]?.[0].data).not.toHaveProperty(
      'status',
    );
  });

  it('replays the original decision after later projection/version changes', async () => {
    const { tx, authorize, order } = setup();
    const original = await authorize();
    const data = tx.salesOrder.update.mock.calls[0]?.[0].data;
    tx.salesOrder.findFirst.mockResolvedValue({
      ...order,
      ...data,
      status: 'COMPLETED',
      version: 20n,
    });
    tx.salesOrder.update.mockClear();
    expect(await authorize()).toEqual(original);
    expect(tx.salesOrder.update).not.toHaveBeenCalled();
  });

  it.each([
    'requestId',
    'shipmentId',
    'reservationGroupId',
    'actorId',
    'orderVersion',
  ] as const)('rejects replay with different %s', async (field) => {
    const { tx, authorize, order } = setup();
    await authorize();
    tx.salesOrder.findFirst.mockResolvedValue({
      ...order,
      ...tx.salesOrder.update.mock.calls[0]?.[0].data,
    });
    tx.salesOrder.update.mockClear();
    const changed =
      field === 'orderVersion'
        ? { orderVersion: 8 }
        : { [field]: randomUUID() };
    await expect(authorize(changed)).rejects.toMatchObject({
      reason: ORDER_ERROR_REASON.DISPATCH_REQUEST_CONFLICT,
      httpStatus: 409,
    });
    expect(tx.salesOrder.update).not.toHaveBeenCalled();
  });

  it('rejects an order outside the caller tenant', async () => {
    const { tx, authorize } = setup();
    tx.salesOrder.findFirst.mockResolvedValue(null);
    await expect(authorize()).rejects.toMatchObject({ httpStatus: 404 });
    expect(tx.salesOrder.update).not.toHaveBeenCalled();
  });

  it('rejects dispatch while cancellation is pending', async () => {
    const { tx, authorize, order } = setup();
    tx.salesOrder.findFirst.mockResolvedValue({
      ...order,
      cancellationRequestedAt: new Date(),
    });
    await expect(authorize()).rejects.toMatchObject({
      reason: ORDER_ERROR_REASON.INVALID_TRANSITION,
      httpStatus: 409,
    });
    expect(tx.salesOrder.update).not.toHaveBeenCalled();
  });

  it.each([
    'DRAFT',
    'PENDING_STOCK',
    'CONFIRMED',
    'PICKING',
    'CANCELED',
    'IN_DELIVERY',
    'COMPLETED',
    'DELIVERY_FAILED',
  ])('does not grant a new dispatch in %s', async (status) => {
    const { tx, authorize, order } = setup();
    tx.salesOrder.findFirst.mockResolvedValue({ ...order, status });
    await expect(authorize()).rejects.toMatchObject({ httpStatus: 409 });
    expect(tx.salesOrder.update).not.toHaveBeenCalled();
  });

  it('rejects a stale order version', async () => {
    const { tx, authorize } = setup();
    await expect(authorize({ orderVersion: 6 })).rejects.toMatchObject({
      reason: ORDER_ERROR_REASON.VERSION_CONFLICT,
    });
    expect(tx.salesOrder.update).not.toHaveBeenCalled();
  });

  it.each([null, randomUUID()])(
    'rejects an unmatched reservation %s',
    async (reservationGroupId) => {
      const { tx, authorize, order } = setup();
      tx.salesOrder.findFirst.mockResolvedValue({
        ...order,
        reservationGroupId,
      });
      await expect(authorize()).rejects.toMatchObject({
        reason: ORDER_ERROR_REASON.RESERVATION_MISMATCH,
      });
      expect(tx.salesOrder.update).not.toHaveBeenCalled();
    },
  );

  it('maps a request key reused for another order to a conflict', async () => {
    const { tx, authorize } = setup();
    tx.salesOrder.update.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Duplicate dispatch request', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    await expect(authorize()).rejects.toMatchObject({
      reason: ORDER_ERROR_REASON.DISPATCH_REQUEST_CONFLICT,
    });
  });

  it('surfaces database failures rather than fabricating a grant', async () => {
    const { tx, authorize } = setup();
    tx.salesOrder.update.mockRejectedValue(new Error('Database unavailable'));
    await expect(authorize()).rejects.toThrow('Database unavailable');
  });
});
