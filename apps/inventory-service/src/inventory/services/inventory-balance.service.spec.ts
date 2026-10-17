import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../../database/prisma.service.js';
import { Prisma, type StockMovement } from '../../generated/prisma/client.js';
import { ReferenceType } from '../inventory.constants.js';
import { InventoryBalanceService } from './inventory-balance.service.js';

function setup() {
  const tenantId = randomUUID();
  const row: StockMovement = {
    id: randomUUID(),
    tenantId,
    warehouseId: randomUUID(),
    productId: randomUUID(),
    balanceId: randomUUID(),
    movementType: 'RECEIPT',
    quantityDelta: new Prisma.Decimal('2'),
    beforeOnHand: new Prisma.Decimal('0'),
    afterOnHand: new Prisma.Decimal('2'),
    referenceType: ReferenceType.STOCK_RECEIPT,
    referenceId: randomUUID(),
    idempotencyKey: 'test-receipt',
    reason: null,
    actorId: randomUUID(),
    correlationId: randomUUID(),
    occurredAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    version: 1n,
    deletedAt: null,
  };
  const prisma = {
    stockMovement: {
      findMany: vi.fn().mockResolvedValue([row]),
      count: vi.fn().mockResolvedValue(1),
    },
    stockReceipt: {
      findMany: vi
        .fn()
        .mockResolvedValue([
          { id: row.referenceId, receiptNumber: 'RECEIPT-001' },
        ]),
    },
    $transaction: vi.fn((operations: Promise<unknown>[]) =>
      Promise.all(operations),
    ),
  };
  return {
    tenantId,
    row,
    prisma,
    service: new InventoryBalanceService(prisma as unknown as PrismaService),
  };
}

describe('Inventory movement reference labels', () => {
  it('resolves receipt numbers in one tenant-scoped batch and preserves IDs/quantities', async () => {
    const s = setup();
    const page = await s.service.listMovements(s.tenantId, {});
    expect(s.prisma.stockReceipt.findMany).toHaveBeenCalledExactlyOnceWith({
      where: {
        tenantId: s.tenantId,
        deletedAt: null,
        id: { in: [s.row.referenceId] },
      },
      select: { id: true, receiptNumber: true },
    });
    expect(page.items[0]).toMatchObject({
      referenceId: s.row.referenceId,
      referenceNumber: 'RECEIPT-001',
      actorId: s.row.actorId,
      quantityDelta: '2.000',
    });
  });
  it('does not guess a number when the tenant receipt no longer exists', async () => {
    const s = setup();
    s.prisma.stockReceipt.findMany.mockResolvedValue([]);
    expect(
      (await s.service.listMovements(s.tenantId, {})).items[0]?.referenceNumber,
    ).toBeNull();
  });
  it('does not query receipt data for shipment or adjustment references', async () => {
    const s = setup();
    s.row.referenceType = ReferenceType.SHIPMENT;
    expect(
      (await s.service.listMovements(s.tenantId, {})).items[0]?.referenceNumber,
    ).toBeNull();
    expect(s.prisma.stockReceipt.findMany).not.toHaveBeenCalled();
  });
  it('deduplicates repeated receipt IDs on the same page', async () => {
    const s = setup();
    s.prisma.stockMovement.findMany.mockResolvedValue([
      s.row,
      { ...s.row, id: randomUUID() },
    ]);
    await s.service.listMovements(s.tenantId, {});
    expect(
      s.prisma.stockReceipt.findMany.mock.calls[0]?.[0].where.id.in,
    ).toEqual([s.row.referenceId]);
  });
  it('propagates lookup failures instead of returning a successful empty label', async () => {
    const s = setup();
    s.prisma.stockReceipt.findMany.mockRejectedValue(
      new Error('receipt database failure'),
    );
    await expect(s.service.listMovements(s.tenantId, {})).rejects.toThrow(
      'receipt database failure',
    );
  });
});
