import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { StockMovementService } from './stock-movement.service.js';
import { PrismaService } from '../../database/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import { MovementType, ReferenceType } from '../inventory.constants.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const WAREHOUSE = '22222222-2222-4222-8222-222222222222';
const PRODUCT = '33333333-3333-4333-8333-333333333333';
const ACTOR = '44444444-4444-4444-8444-444444444444';

function balanceRow(onHand: string, reserved = '0') {
  return {
    id: 'balance-1',
    tenantId: TENANT,
    warehouseId: WAREHOUSE,
    productId: PRODUCT,
    onHandQuantity: new Prisma.Decimal(onHand),
    reservedQuantity: new Prisma.Decimal(reserved),
    lowStockThreshold: new Prisma.Decimal('0'),
    version: 1n,
    updatedAt: new Date(),
  };
}

function movementRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'movement-1',
    warehouseId: WAREHOUSE,
    productId: PRODUCT,
    movementType: MovementType.RECEIPT,
    quantityDelta: new Prisma.Decimal('5'),
    beforeOnHand: new Prisma.Decimal('0'),
    afterOnHand: new Prisma.Decimal('5'),
    referenceType: ReferenceType.STOCK_RECEIPT,
    referenceId: 'receipt-1',
    reason: null,
    actorId: ACTOR,
    occurredAt: new Date(),
    ...overrides,
  };
}

function command(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    warehouseId: WAREHOUSE,
    productId: PRODUCT,
    movementType: MovementType.RECEIPT,
    quantityDelta: '5',
    referenceType: ReferenceType.STOCK_RECEIPT,
    referenceId: 'receipt-1',
    idempotencyKey: 'key-1',
    actorId: ACTOR,
    correlationId: 'correlation-1',
    occurredAt: new Date(),
    ...overrides,
  } as Parameters<StockMovementService['applyMovementInTransaction']>[1];
}

describe('StockMovementService', () => {
  let service: StockMovementService;
  let tx: any;

  beforeEach(async () => {
    tx = {
      stockMovement: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockImplementation(({ data }: any) =>
          Promise.resolve(movementRow(data)),
        ),
      },
      inventoryBalance: {
        findFirstOrThrow: vi.fn().mockResolvedValue(balanceRow('0')),
        update: vi.fn().mockResolvedValue({ ...balanceRow('5'), version: 2n }),
      },
      outboxEvent: { create: vi.fn().mockResolvedValue({}) },
      $executeRaw: vi.fn().mockResolvedValue(1),
      $queryRaw: vi.fn().mockResolvedValue([{ id: 'balance-1' }]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StockMovementService,
        { provide: PrismaService, useValue: { stockMovement: { findFirst: vi.fn() } } },
      ],
    }).compile();

    service = module.get(StockMovementService);
  });

  it('writes one movement and one outbox event for a receipt', async () => {
    await service.applyMovementInTransaction(tx, command());

    expect(tx.stockMovement.create).toHaveBeenCalledTimes(1);
    expect(tx.outboxEvent.create).toHaveBeenCalledTimes(1);
    expect(tx.inventoryBalance.update).toHaveBeenCalledTimes(1);
  });

  it('records beforeOnHand and afterOnHand consistent with the delta', async () => {
    tx.inventoryBalance.findFirstOrThrow.mockResolvedValue(balanceRow('10'));

    await service.applyMovementInTransaction(tx, command({ quantityDelta: '2.5' }));

    const data = tx.stockMovement.create.mock.calls[0][0].data;
    expect(data.beforeOnHand.toFixed(3)).toBe('10.000');
    expect(data.afterOnHand.toFixed(3)).toBe('12.500');
  });

  it('keeps three decimal digits without floating point drift', async () => {
    tx.inventoryBalance.findFirstOrThrow.mockResolvedValue(balanceRow('0.1'));

    await service.applyMovementInTransaction(tx, command({ quantityDelta: '0.2' }));

    const data = tx.stockMovement.create.mock.calls[0][0].data;
    expect(data.afterOnHand.toFixed(3)).toBe('0.300');
  });

  it('rejects a zero delta', async () => {
    await expect(
      service.applyMovementInTransaction(tx, command({ quantityDelta: '0' })),
    ).rejects.toThrow(BadRequestException);

    expect(tx.stockMovement.create).not.toHaveBeenCalled();
  });

  it('rejects an adjustment without a reason', async () => {
    await expect(
      service.applyMovementInTransaction(
        tx,
        command({
          movementType: MovementType.ADJUSTMENT_OUT,
          quantityDelta: '-1',
          referenceType: ReferenceType.MANUAL_ADJUSTMENT,
          reason: '   ',
        }),
      ),
    ).rejects.toThrow(BadRequestException);

    expect(tx.stockMovement.create).not.toHaveBeenCalled();
  });

  it('rejects a decrease that would push on-hand below zero', async () => {
    tx.inventoryBalance.findFirstOrThrow.mockResolvedValue(balanceRow('3'));

    await expect(
      service.applyMovementInTransaction(
        tx,
        command({
          movementType: MovementType.ADJUSTMENT_OUT,
          quantityDelta: '-5',
          referenceType: ReferenceType.MANUAL_ADJUSTMENT,
          reason: 'kiem ke',
        }),
      ),
    ).rejects.toThrow(BadRequestException);

    expect(tx.inventoryBalance.update).not.toHaveBeenCalled();
  });

  it('rejects a decrease that would push available below zero', async () => {
    tx.inventoryBalance.findFirstOrThrow.mockResolvedValue(balanceRow('10', '8'));

    await expect(
      service.applyMovementInTransaction(
        tx,
        command({
          movementType: MovementType.ADJUSTMENT_OUT,
          quantityDelta: '-5',
          referenceType: ReferenceType.MANUAL_ADJUSTMENT,
          reason: 'kiem ke',
        }),
      ),
    ).rejects.toThrow(BadRequestException);

    expect(tx.inventoryBalance.update).not.toHaveBeenCalled();
  });

  it('replays a duplicate idempotency key without writing again', async () => {
    tx.stockMovement.findFirst.mockResolvedValue(movementRow());

    const result = await service.applyMovementInTransaction(tx, command());

    expect(result.id).toBe('movement-1');
    expect(tx.stockMovement.create).not.toHaveBeenCalled();
    expect(tx.inventoryBalance.update).not.toHaveBeenCalled();
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
  });

  it('locks the balance row before reading it', async () => {
    await service.applyMovementInTransaction(tx, command());

    expect(tx.$queryRaw).toHaveBeenCalled();
    const lockOrder = tx.$queryRaw.mock.invocationCallOrder[0];
    const readOrder = tx.inventoryBalance.findFirstOrThrow.mock.invocationCallOrder[0];
    expect(lockOrder).toBeLessThan(readOrder);
  });
});
