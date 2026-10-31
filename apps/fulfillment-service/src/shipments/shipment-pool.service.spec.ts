import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../database/prisma.service.js';
import { ShipmentPoolService } from './shipment-pool.service.js';

function setup() {
  const rows = [
    {
      id: randomUUID(),
      shipmentNumber: 'SHP-0001',
      orderId: randomUUID(),
      warehouseId: randomUUID(),
      version: 12n,
      confirmedOrderVersion: 9n,
      totalWeight: { toString: () => '12.340' },
      totalVolume: { toString: () => '0.012345' },
    },
  ];
  const shipment = {
    findMany: vi.fn(
      async (_args: {
        where: object;
        orderBy: object[];
        skip: number;
        take: number;
      }) => rows,
    ),
    count: vi.fn(async (_args: { where: object }) => 1),
  };
  const prisma = {
    shipment,
    $transaction: vi.fn(async (queries: Promise<unknown>[]) =>
      Promise.all(queries),
    ),
  };
  return {
    rows,
    shipment,
    service: new ShipmentPoolService(prisma as unknown as PrismaService),
  };
}

describe('Authoritative ready shipment pool', () => {
  it('filters tenant, warehouse, claims, pending dispatch and exclusions before count/page', async () => {
    const s = setup();
    const tenantId = randomUUID();
    const warehouseId = randomUUID();
    const excludedShipmentId = randomUUID();
    const result = await s.service.list(
      tenantId,
      {
        contractVersion: '1',
        warehouseId,
        page: '2',
        pageSize: '10',
        status: 'READY_TO_SHIP',
      },
      [excludedShipmentId],
    );

    const findArgs = s.shipment.findMany.mock.calls[0]?.[0];
    const countArgs = s.shipment.count.mock.calls[0]?.[0];
    expect(findArgs.where).toEqual(countArgs.where);
    expect(findArgs.where).toMatchObject({
      tenantId,
      warehouseId,
      status: 'READY_TO_SHIP',
      deletedAt: null,
      assignedTripId: null,
      id: { notIn: [excludedShipmentId] },
      dispatchIntent: { isNot: { status: 'PENDING' } },
    });
    expect(findArgs).toMatchObject({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: 10,
      take: 10,
    });
    expect(result).toEqual({
      items: [
        {
          shipmentId: s.rows[0].id,
          shipmentNumber: 'SHP-0001',
          orderId: s.rows[0].orderId,
          warehouseId: s.rows[0].warehouseId,
          shipmentVersion: 12,
          orderVersion: 9,
          status: 'READY_TO_SHIP',
          totalWeight: '12.340',
          totalVolume: '0.012345',
        },
      ],
      total: 1,
      page: 2,
      pageSize: 10,
    });
  });

  it.each([
    [{ contractVersion: '1', warehouseId: randomUUID(), page: ['1'] }, []],
    [
      {
        contractVersion: '1',
        warehouseId: randomUUID(),
        tenantId: randomUUID(),
      },
      [],
    ],
    [
      {
        contractVersion: '1',
        warehouseId: randomUUID(),
      },
      ['not-a-uuid'],
    ],
  ])(
    'rejects malformed or tenant-overriding pool query',
    async (query, excluded) => {
      const s = setup();
      await expect(
        s.service.list(randomUUID(), query, excluded),
      ).rejects.toMatchObject({ status: 400 });
      expect(s.shipment.findMany).not.toHaveBeenCalled();
      expect(s.shipment.count).not.toHaveBeenCalled();
    },
  );
});
