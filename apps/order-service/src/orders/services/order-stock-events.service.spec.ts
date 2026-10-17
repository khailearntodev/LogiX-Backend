import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ServiceId } from '@logix/common';
import { PrismaService } from '../../database/prisma.service.js';
import { OrderReservationService } from './order-reservation.service.js';
import { OrderStockEventsService } from './order-stock-events.service.js';
import {
  TENANT_ID,
  WAREHOUSE_ID,
  PRODUCT_A_ID,
} from '../../../test/fixtures/order.fixtures.js';

const event = {
  eventId: '00000000-0000-4000-8000-000000000010',
  eventType: 'StockReceived',
  eventVersion: 1,
  tenantId: TENANT_ID,
  correlationId: '00000000-0000-4000-8000-000000000011',
  actorId: null,
  causationId: '00000000-0000-4000-8000-000000000011',
  producer: ServiceId.INVENTORY_SERVICE,
  aggregateId: '00000000-0000-4000-8000-000000000012',
  aggregateType: 'InventoryBalance',
  aggregateVersion: 1,
  occurredAt: new Date().toISOString(),
  payload: { warehouseId: WAREHOUSE_ID, productId: PRODUCT_A_ID },
};

async function setup() {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    inboxEvent: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
    },
    salesOrder: {
      findMany: vi.fn().mockResolvedValue([
        { id: 'first', version: 1n },
        { id: 'second', version: 2n },
      ]),
    },
  };
  const reservations = {
    confirm: vi.fn().mockResolvedValue({ status: 'PENDING_STOCK' }),
  };
  const module = await Test.createTestingModule({
    providers: [
      OrderStockEventsService,
      {
        provide: PrismaService,
        useValue: {
          $transaction: (callback: (value: typeof tx) => Promise<void>) =>
            callback(tx),
        },
      },
      { provide: OrderReservationService, useValue: reservations },
      {
        provide: ConfigService,
        useValue: new ConfigService({ OUTBOX_TRANSACTION_TIMEOUT_MS: 120000 }),
      },
    ],
  }).compile();
  return { service: module.get(OrderStockEventsService), tx, reservations };
}

describe('OrderStockEventsService', () => {
  it('serializes a tenant/warehouse FIFO queue and continues when an earlier order remains insufficient', async () => {
    const { service, tx, reservations } = await setup();
    await service.handle(event);
    expect(tx.salesOrder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: TENANT_ID,
          warehouseId: WAREHOUSE_ID,
          status: 'PENDING_STOCK',
        }),
        orderBy: [{ pendingSince: 'asc' }, { id: 'asc' }],
      }),
    );
    expect(reservations.confirm.mock.calls.map((call) => call[0])).toEqual([
      'first',
      'second',
    ]);
    expect(reservations.confirm.mock.calls[0][2].eventId).toBe(event.eventId);
    expect(tx.inboxEvent.create).toHaveBeenCalledTimes(1);
  });

  it('deduplicates a processed event before searching pending orders', async () => {
    const { service, tx, reservations } = await setup();
    tx.inboxEvent.findUnique.mockResolvedValue({ id: 'processed' });
    await service.handle(event);
    expect(tx.salesOrder.findMany).not.toHaveBeenCalled();
    expect(reservations.confirm).not.toHaveBeenCalled();
  });

  it('uses OrderPendingStock to close the receipt-before-pending lost wakeup window', async () => {
    const { service, reservations } = await setup();
    await service.handle({
      ...event,
      eventType: 'OrderPendingStock',
      producer: ServiceId.ORDER_SERVICE,
      payload: {
        warehouseId: WAREHOUSE_ID,
        shortageItems: [{ productId: PRODUCT_A_ID }],
      },
    });
    expect(reservations.confirm).toHaveBeenCalledTimes(2);
  });

  it('leaves the warehouse event retryable when a dependency fails', async () => {
    const { service, tx, reservations } = await setup();
    reservations.confirm.mockRejectedValue(new Error('inventory unavailable'));
    await expect(service.handle(event)).rejects.toThrow(
      'inventory unavailable',
    );
    expect(tx.inboxEvent.create).not.toHaveBeenCalled();
  });

  it('rejects an invalid producer without processing business data', async () => {
    const { service, reservations } = await setup();
    await expect(
      service.handle({ ...event, producer: ServiceId.ORDER_SERVICE }),
    ).rejects.toThrow('Unexpected inventory event producer');
    expect(reservations.confirm).not.toHaveBeenCalled();
  });
});
