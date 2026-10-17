import { Test } from '@nestjs/testing';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { InventoryClient } from '../integrations/inventory.client.js';
import { OrderOutboxWriter } from '../outbox/order-outbox.writer.js';
import { OrderReservationService } from './order-reservation.service.js';
import { OrderErrors } from '../domain/order-errors.js';
import {
  commandContext,
  salesOrderFixture,
  ORDER_ID,
  TENANT_ID,
  PRODUCT_A_ID,
} from '../../../test/fixtures/order.fixtures.js';

const GROUP_ID = '00000000-0000-4000-8000-000000000090';

async function setup(status = 'DRAFT') {
  let order = salesOrderFixture({
    status,
    pendingSince: status === 'PENDING_STOCK' ? new Date('2026-10-01') : null,
  });
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    salesOrder: {
      findFirst: vi.fn(async () => order),
      update: vi.fn(
        async ({
          data,
        }: {
          data: {
            status: string;
            confirmedAt?: Date;
            reservationGroupId?: string;
            pendingSince?: Date;
          };
        }) => {
          order = { ...order, ...data, version: order.version + 1n };
          return order;
        },
      ),
    },
    orderShortage: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    orderStatusHistory: { create: vi.fn() },
    inboxEvent: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
    },
  };
  const database = {
    ...tx,
    $transaction: vi.fn(
      async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx),
    ),
  };
  const inventory = {
    reserve: vi
      .fn()
      .mockResolvedValue({ outcome: 'RESERVED', reservationGroupId: GROUP_ID }),
    preview: vi
      .fn()
      .mockResolvedValue({ checkedAt: new Date().toISOString(), lines: [] }),
  };
  const outbox = { write: vi.fn() };
  const module = await Test.createTestingModule({
    providers: [
      OrderReservationService,
      { provide: PrismaService, useValue: database },
      { provide: InventoryClient, useValue: inventory },
      { provide: OrderOutboxWriter, useValue: outbox },
    ],
  }).compile();
  return {
    service: module.get(OrderReservationService),
    tx,
    inventory,
    outbox,
    getOrder: () => order,
  };
}

describe('OrderReservationService', () => {
  const reconcileRequest = () => {
    const order = salesOrderFixture();
    return {
      orderId: order.id,
      reservationGroupId: GROUP_ID,
      orderVersion: Number(order.version),
      warehouseId: order.warehouseId,
      lines: order.lines.map((line) => ({
        orderLineId: line.id,
        productId: line.productId,
        quantity: line.quantity.toFixed(3),
      })),
    };
  };

  it('recovers a matching orphan reservation by confirming the current order', async () => {
    const { service, inventory } = await setup();
    expect(await service.reconcile(reconcileRequest(), commandContext)).toEqual(
      {
        decision: 'ACKNOWLEDGE',
      },
    );
    expect(inventory.reserve).toHaveBeenCalledTimes(1);
  });

  it('acknowledges an already referenced group without reserving again', async () => {
    const { service, inventory } = await setup();
    await service.confirm(ORDER_ID, 1, commandContext);
    inventory.reserve.mockClear();
    expect(await service.reconcile(reconcileRequest(), commandContext)).toEqual(
      {
        decision: 'ACKNOWLEDGE',
      },
    );
    expect(inventory.reserve).not.toHaveBeenCalled();
  });

  it('keeps reservations while a durable cancellation is being recovered', async () => {
    const { service, tx, inventory } = await setup();
    tx.salesOrder.findFirst.mockResolvedValue(
      salesOrderFixture({ cancellationRequestedAt: new Date() }),
    );
    expect(await service.reconcile(reconcileRequest(), commandContext)).toEqual(
      {
        decision: 'KEEP',
      },
    );
    expect(inventory.reserve).not.toHaveBeenCalled();
  });

  it.each(['CANCELED', 'CONFIRMED'])(
    'authorizes release for an unused group on a %s order',
    async (status) => {
      const { service, inventory } = await setup(status);
      expect(
        await service.reconcile(reconcileRequest(), commandContext),
      ).toEqual({
        decision: 'RELEASE',
      });
      expect(inventory.reserve).not.toHaveBeenCalled();
    },
  );

  it.each(['version', 'warehouse', 'quantity', 'line'])(
    'does not adopt a reservation whose %s differs from current business content',
    async (field) => {
      const { service, inventory } = await setup();
      const request = reconcileRequest();
      if (field === 'version') request.orderVersion++;
      if (field === 'warehouse') request.warehouseId = GROUP_ID;
      if (field === 'quantity') request.lines[0].quantity = '9.000';
      if (field === 'line') request.lines[0].orderLineId = GROUP_ID;
      expect(await service.reconcile(request, commandContext)).toEqual({
        decision: 'RELEASE',
      });
      expect(inventory.reserve).not.toHaveBeenCalled();
    },
  );

  it('does not authorize release when recovery itself cannot reach inventory', async () => {
    const { service, inventory } = await setup();
    inventory.reserve.mockRejectedValue(
      OrderErrors.upstreamUnavailable('inventory-service'),
    );
    await expect(
      service.reconcile(reconcileRequest(), commandContext),
    ).rejects.toMatchObject({ httpStatus: 503 });
  });

  it('locks the tenant order before reserve and confirms without refreshing snapshots', async () => {
    const { service, tx, inventory, outbox } = await setup();
    const result = await service.confirm(ORDER_ID, 1, commandContext);
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      inventory.reserve.mock.invocationCallOrder[0],
    );
    expect(inventory.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: ORDER_ID,
        orderVersion: 1,
        lines: [
          expect.objectContaining({
            productId: PRODUCT_A_ID,
            quantity: '10.000',
          }),
        ],
      }),
      commandContext,
    );
    expect(result.status).toBe('CONFIRMED');
    expect(result.version).toBe(2);
    expect(result.reservationGroupId).toBe(GROUP_ID);
    expect(tx.salesOrder.update.mock.calls[0][0].data).not.toHaveProperty(
      'customerSnapshot',
    );
    expect(outbox.write).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        eventType: 'OrderConfirmed',
        payload: expect.objectContaining({ reservationGroupId: GROUP_ID }),
      }),
    );
  });

  it('stores shortage and pending timestamp when inventory reports insufficient', async () => {
    const { service, inventory, tx, outbox } = await setup();
    inventory.reserve.mockResolvedValue({
      outcome: 'INSUFFICIENT',
      shortages: [
        { productId: PRODUCT_A_ID, required: '10.000', available: '2.000' },
      ],
    });
    const result = await service.confirm(ORDER_ID, 1, commandContext);
    expect(result.status).toBe('PENDING_STOCK');
    expect(result.confirmedAt).toBeNull();
    expect(result.pendingSince).toBeInstanceOf(Date);
    expect(tx.orderShortage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: TENANT_ID,
          requiredQuantity: '10.000',
          availableQuantity: '2.000',
        }),
      }),
    );
    expect(outbox.write).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ eventType: 'OrderPendingStock' }),
    );
  });

  it('does not reset the FIFO timestamp or duplicate status history on an insufficient retry', async () => {
    const { service, inventory, tx, getOrder, outbox } =
      await setup('PENDING_STOCK');
    const original = getOrder().pendingSince;
    inventory.reserve.mockResolvedValue({
      outcome: 'INSUFFICIENT',
      shortages: [
        { productId: PRODUCT_A_ID, required: '10.000', available: '0.000' },
      ],
    });
    const result = await service.confirm(ORDER_ID, 1, commandContext, true);
    expect(result.pendingSince).toEqual(original);
    expect(tx.orderStatusHistory.create).not.toHaveBeenCalled();
    expect(outbox.write).not.toHaveBeenCalled();
  });

  it('updates an identical shortage rather than creating another active record', async () => {
    const { service, inventory, tx } = await setup('PENDING_STOCK');
    inventory.reserve.mockResolvedValue({
      outcome: 'INSUFFICIENT',
      shortages: [
        { productId: PRODUCT_A_ID, required: '10.000', available: '0.000' },
      ],
    });
    tx.orderShortage.findFirst.mockResolvedValue({ id: 'existing-shortage' });
    await service.confirm(ORDER_ID, 1, commandContext, true);
    expect(tx.orderShortage.update).toHaveBeenCalled();
    expect(tx.orderShortage.create).not.toHaveBeenCalled();
  });

  it('rejects a stale version before calling inventory', async () => {
    const { service, inventory } = await setup();
    await expect(
      service.confirm(ORDER_ID, 2, commandContext),
    ).rejects.toMatchObject({
      reason: 'ORDER_VERSION_CONFLICT',
    });
    expect(inventory.reserve).not.toHaveBeenCalled();
  });

  it.each(['CONFIRMED', 'CANCELED', 'DELIVERED'])(
    'rejects %s before calling inventory',
    async (status) => {
      const { service, inventory } = await setup(status);
      await expect(
        service.confirm(ORDER_ID, 1, commandContext),
      ).rejects.toMatchObject({
        reason: 'ORDER_INVALID_TRANSITION',
      });
      expect(inventory.reserve).not.toHaveBeenCalled();
    },
  );

  it('requires pending stock for a manual retry', async () => {
    const { service, inventory } = await setup();
    await expect(
      service.confirm(ORDER_ID, 1, commandContext, true),
    ).rejects.toMatchObject({
      reason: 'ORDER_INVALID_TRANSITION',
    });
    expect(inventory.reserve).not.toHaveBeenCalled();
  });

  it('leaves the order and shortages untouched when inventory is unavailable', async () => {
    const { service, inventory, tx, outbox } = await setup();
    inventory.reserve.mockRejectedValue(
      OrderErrors.upstreamUnavailable('inventory-service'),
    );
    await expect(
      service.confirm(ORDER_ID, 1, commandContext),
    ).rejects.toMatchObject({ httpStatus: 503 });
    expect(tx.salesOrder.update).not.toHaveBeenCalled();
    expect(tx.orderShortage.create).not.toHaveBeenCalled();
    expect(outbox.write).not.toHaveBeenCalled();
  });

  it('commits a per-order inbox entry with the decision and skips duplicate business effects', async () => {
    const { service, inventory, tx } = await setup('PENDING_STOCK');
    const eventCtx = { ...commandContext, eventId: 'event-1' };
    await service.confirm(ORDER_ID, 1, eventCtx, true);
    expect(tx.inboxEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          consumerName: `order-reservation:${ORDER_ID}`,
          eventId: 'event-1',
        }),
      }),
    );
    tx.inboxEvent.findUnique.mockResolvedValue({ id: 'already-processed' });
    await service.confirm(ORDER_ID, 1, eventCtx, true);
    expect(inventory.reserve).toHaveBeenCalledTimes(1);
  });

  it('serializes shortage decimals without float conversion', async () => {
    const { service, tx } = await setup('PENDING_STOCK');
    tx.orderShortage.findMany.mockResolvedValue([
      {
        id: 'shortage',
        productId: PRODUCT_A_ID,
        warehouseId: 'warehouse',
        requiredQuantity: new Prisma.Decimal('999999999999999.999'),
        availableQuantity: new Prisma.Decimal('0.001'),
        detectedAt: new Date(),
      },
    ]);
    expect((await service.shortages(TENANT_ID, ORDER_ID))[0].required).toBe(
      '999999999999999.999',
    );
  });
});
