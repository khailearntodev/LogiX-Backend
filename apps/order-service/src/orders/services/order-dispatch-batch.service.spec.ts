import { randomUUID } from 'node:crypto';
import { batchDispatchGrantRequestSchema } from '@logix/messaging';
import { PrismaService } from '../../database/prisma.service.js';
import { OrderDispatchBatchService } from './order-dispatch-batch.service.js';

function setup(canceled = false) {
  const request = batchDispatchGrantRequestSchema.parse({
    contractVersion: 1, tenantId: randomUUID(), tripId: randomUUID(), requestId: randomUUID(),
    actorId: randomUUID(), approvedPlanId: randomUUID(), inputHash: 'a'.repeat(64),
    expectedTripVersion: 3, dispatchVersion: 1,
    shipments: [0, 1].map(() => ({
      shipmentId: randomUUID(), orderId: randomUUID(), reservationGroupId: randomUUID(),
      orderVersion: 2, shipmentVersion: 4, dispatchRequestId: randomUUID(),
    })),
  });
  const orders = new Map(request.shipments.map((item, index) => [item.orderId, {
    id: item.orderId, status: 'READY_TO_SHIP', version: 2n, reservationGroupId: item.reservationGroupId,
    dispatchGrantedAt: null, cancellationRequestedAt: canceled && index === 1 ? new Date() : null,
  }]));
  const calls: string[] = [];
  const tx = {
    $queryRaw: vi.fn(async () => { calls.push('lock'); }),
    orderDispatchBatch: { findFirst: vi.fn(), create: vi.fn() },
    salesOrder: {
      findFirst: vi.fn(async ({ where }: { where: { id?: string } }) => {
        calls.push('validate');
        return where.id ? orders.get(where.id) : null;
      }),
      update: vi.fn(async () => { calls.push('write'); }),
    },
  };
  const prisma = { $transaction: async (fn: (value: typeof tx) => Promise<unknown>) => fn(tx) };
  return { request, tx, calls, service: new OrderDispatchBatchService(prisma as unknown as PrismaService) };
}

describe('Order whole-set dispatch authority', () => {
  it('locks every Order and validates the complete set before writing any irrevocable grant', async () => {
    const s = setup();
    const decision = await s.service.authorize(s.request);
    expect(decision.decision).toBe('GRANTED');
    expect(s.tx.salesOrder.update).toHaveBeenCalledTimes(2);
    expect(s.calls.slice(0, 3)).toEqual(['lock', 'lock', 'lock']);
    expect(s.calls.lastIndexOf('validate')).toBeLessThan(s.calls.indexOf('write'));
    expect(s.tx.orderDispatchBatch.create).toHaveBeenCalledOnce();
  });
  it('durably rejects the full set with zero writes when one Order is cancel-pending', async () => {
    const s = setup(true);
    expect(await s.service.authorize(s.request)).toMatchObject({ decision: 'REJECTED', grantCount: 0 });
    expect(s.tx.salesOrder.update).not.toHaveBeenCalled();
    expect(s.tx.orderDispatchBatch.create).toHaveBeenCalledOnce();
  });
});
