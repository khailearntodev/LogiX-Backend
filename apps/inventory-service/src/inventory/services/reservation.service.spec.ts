import { Test } from '@nestjs/testing';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { ReservationService } from './reservation.service.js';
import type { ReserveDto } from '../dto/reserve.dto.js';

const ctx = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  correlationId: '22222222-2222-4222-8222-222222222222',
};
const dto: ReserveDto = {
  orderId: '33333333-3333-4333-8333-333333333333',
  orderVersion: 1,
  warehouseId: '44444444-4444-4444-8444-444444444444',
  lines: [
    {
      orderLineId: '55555555-5555-4555-8555-555555555555',
      productId: '66666666-6666-4666-8666-666666666666',
      quantity: '3',
    },
    {
      orderLineId: '77777777-7777-4777-8777-777777777777',
      productId: '88888888-8888-4888-8888-888888888888',
      quantity: '4',
    },
  ],
};
const key = `order:${dto.orderId}:v1`;
const group = {
  id: '99999999-9999-4999-8999-999999999999',
  ...ctx,
  orderId: dto.orderId,
  warehouseId: dto.warehouseId,
  orderVersion: 1n,
  status: 'ACTIVE',
  idempotencyKey: key,
  version: 1n,
};
const balance = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  onHandQuantity: new Prisma.Decimal('10'),
  reservedQuantity: new Prisma.Decimal('2'),
};

function transactionMock() {
  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    inventoryBalance: {
      findFirst: vi.fn().mockResolvedValue(balance),
      findFirstOrThrow: vi.fn().mockResolvedValue(balance),
      update: vi.fn().mockResolvedValue(balance),
    },
    reservationGroup: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue(group),
      update: vi
        .fn()
        .mockResolvedValue({ ...group, status: 'RELEASED', version: 2n }),
    },
    inventoryReservation: {
      create: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    outboxEvent: { create: vi.fn().mockResolvedValue({}) },
  };
}

describe('ReservationService', () => {
  let tx: ReturnType<typeof transactionMock>;
  let service: ReservationService;

  beforeEach(async () => {
    tx = transactionMock();
    const module = await Test.createTestingModule({
      providers: [
        ReservationService,
        {
          provide: PrismaService,
          useValue: {
            $transaction: (callback: (value: typeof tx) => Promise<unknown>) =>
              callback(tx),
          },
        },
      ],
    }).compile();
    service = module.get(ReservationService);
  });

  it('reserves all lines and writes one event without changing on-hand', async () => {
    expect(await service.reserve(dto, key, ctx)).toEqual({
      outcome: 'RESERVED',
      reservationGroupId: group.id,
    });
    expect(tx.inventoryBalance.update).toHaveBeenCalledTimes(2);
    expect(tx.inventoryReservation.create).toHaveBeenCalledTimes(2);
    expect(tx.outboxEvent.create).toHaveBeenCalledTimes(1);
    for (const [arg] of tx.inventoryBalance.update.mock.calls) {
      expect(arg.data.onHandQuantity).toBeUndefined();
      expect(arg.data.version).toEqual({ increment: 1 });
    }
  });

  it.each([
    ['one SKU', [balance, null]],
    ['all SKUs', [null, null]],
  ])(
    'does not reserve anything when %s is missing',
    async (_description, rows) => {
      tx.inventoryBalance.findFirst
        .mockResolvedValueOnce(rows[0])
        .mockResolvedValueOnce(rows[1]);
      const result = await service.reserve(dto, key, ctx);
      expect(result.outcome).toBe('INSUFFICIENT');
      expect(tx.inventoryBalance.update).not.toHaveBeenCalled();
      expect(tx.reservationGroup.create).not.toHaveBeenCalled();
      expect(tx.inventoryReservation.create).not.toHaveBeenCalled();
      expect(tx.outboxEvent.create).not.toHaveBeenCalled();
    },
  );

  it('returns exact decimal shortages and reevaluates on retry', async () => {
    tx.inventoryBalance.findFirst.mockResolvedValueOnce({
      ...balance,
      onHandQuantity: new Prisma.Decimal('2.001'),
      reservedQuantity: new Prisma.Decimal('0.002'),
    });
    expect(await service.reserve(dto, key, ctx)).toEqual({
      outcome: 'INSUFFICIENT',
      shortages: [
        {
          productId: dto.lines[0].productId,
          required: '3.000',
          available: '1.999',
        },
      ],
    });
    expect((await service.reserve(dto, key, ctx)).outcome).toBe('RESERVED');
  });

  it('locks products in fixed order regardless of request order', async () => {
    await service.reserve(
      { ...dto, lines: [...dto.lines].reverse() },
      key,
      ctx,
    );
    const locks = tx.$queryRaw.mock.calls.slice(1);
    expect(locks.map(([sql]) => sql.values.at(-1))).toEqual(
      dto.lines.map((line) => line.productId),
    );
  });

  it('replays an active reservation without additional stock changes', async () => {
    tx.reservationGroup.findFirst.mockResolvedValueOnce({
      ...group,
      reservations: dto.lines.map((line) => ({
        ...line,
        quantity: new Prisma.Decimal(line.quantity),
      })),
    });
    expect((await service.reserve(dto, key, ctx)).outcome).toBe('RESERVED');
    expect(tx.inventoryBalance.update).not.toHaveBeenCalled();
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
  });

  it('rejects a replay after release instead of reporting RESERVED', async () => {
    tx.reservationGroup.findFirst.mockResolvedValueOnce({
      ...group,
      status: 'RELEASED',
      reservations: [],
    });
    await expect(service.reserve(dto, key, ctx)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('rejects reusing a key with changed content', async () => {
    tx.reservationGroup.findFirst.mockResolvedValueOnce({
      ...group,
      reservations: dto.lines.map((line) => ({
        ...line,
        quantity: new Prisma.Decimal('1'),
      })),
    });
    await expect(service.reserve(dto, key, ctx)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('rejects a second active reservation for another order version', async () => {
    tx.reservationGroup.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(group);
    await expect(service.reserve(dto, key, ctx)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it.each([
    { ...dto, lines: [dto.lines[0], dto.lines[0]] },
    { ...dto, lines: [{ ...dto.lines[0], quantity: '0' }] },
    { ...dto, lines: [] },
  ])('rejects invalid line rules', async (input) => {
    await expect(service.reserve(input, key, ctx)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it('rejects an idempotency key for another version', async () => {
    await expect(service.reserve(dto, `${key}2`, ctx)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('release is a no-op when no active group remains', async () => {
    expect(await service.release(dto.orderId, ctx)).toEqual({
      outcome: 'RELEASED',
    });
    expect(tx.inventoryBalance.update).not.toHaveBeenCalled();
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
  });

  it('release decrements reserved only and writes one event per group', async () => {
    tx.reservationGroup.findMany.mockResolvedValueOnce([
      {
        ...group,
        reservations: [
          {
            ...dto.lines[0],
            balanceId: balance.id,
            quantity: new Prisma.Decimal('1'),
          },
        ],
      },
    ]);
    await service.release(dto.orderId, ctx);
    expect(tx.inventoryBalance.update).toHaveBeenCalledWith({
      where: { id: balance.id },
      data: {
        reservedQuantity: { decrement: new Prisma.Decimal('1') },
        version: { increment: 1 },
      },
    });
    expect(tx.reservationGroup.update).toHaveBeenCalledTimes(1);
    expect(tx.outboxEvent.create).toHaveBeenCalledTimes(1);
  });

  it('refuses to hide an inconsistent reserved balance', async () => {
    tx.reservationGroup.findMany.mockResolvedValueOnce([
      {
        ...group,
        reservations: [
          {
            ...dto.lines[0],
            balanceId: balance.id,
            quantity: new Prisma.Decimal('3'),
          },
        ],
      },
    ]);
    await expect(service.release(dto.orderId, ctx)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(tx.inventoryBalance.update).not.toHaveBeenCalled();
  });
});
