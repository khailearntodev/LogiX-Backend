import { randomUUID } from 'node:crypto';
import { plainToInstance } from 'class-transformer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SHIPMENT_STATUS as S } from '@logix/messaging';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../database/prisma.service.js';
import { ShipmentQueryDto } from './shipment.dto.js';
import { ShipmentQueryService } from './shipment-query.service.js';

describe('Shipment list query', () => {
  const tenantId = randomUUID();
  const findMany = vi.fn();
  const count = vi.fn();
  const transaction = vi.fn((queries: Promise<unknown>[]) =>
    Promise.all(queries),
  );
  const prisma = {
    shipment: { findMany, count },
    $transaction: transaction,
  };
  let service: ShipmentQueryService;

  beforeEach(async () => {
    vi.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        { provide: PrismaService, useValue: prisma },
        {
          provide: ShipmentQueryService,
          inject: [PrismaService],
          useFactory: (database: PrismaService) =>
            new ShipmentQueryService(database),
        },
      ],
    }).compile();
    service = module.get(ShipmentQueryService);
    findMany.mockResolvedValue([{ id: randomUUID(), version: 1n }]);
    count.mockResolvedValue(5);
  });

  it('applies the status IN set and every filter to items AND count before pagination', async () => {
    const warehouseId = randomUUID();
    const orderId = randomUUID();
    const result = await service.list(
      tenantId,
      plainToInstance(ShipmentQueryDto, {
        statuses: 'PENDING_PICK,PICKING',
        warehouseId,
        orderId,
        createdFrom: '2026-01-01T00:00:00.000Z',
        createdTo: '2026-02-01T00:00:00.000Z',
        page: '2',
        pageSize: '2',
      }),
    );
    const where = {
      tenantId,
      deletedAt: null,
      warehouseId,
      orderId,
      status: { in: [S.PENDING_PICK, S.PICKING] },
      createdAt: {
        gte: new Date('2026-01-01T00:00:00.000Z'),
        lte: new Date('2026-02-01T00:00:00.000Z'),
      },
    };
    expect(findMany).toHaveBeenCalledExactlyOnceWith({
      where,
      include: { dispatchIntent: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: 2,
      take: 2,
    });
    expect(count).toHaveBeenCalledExactlyOnceWith({ where });
    expect(result).toEqual({
      items: [{ id: expect.any(String), version: 1 }],
      total: 5,
      page: 2,
      pageSize: 2,
    });
    expect(transaction).toHaveBeenCalledOnce();
  });

  it.each([undefined, S.READY_TO_SHIP])(
    'preserves legacy/default filters for status %s',
    async (status) => {
      await service.list(
        tenantId,
        plainToInstance(ShipmentQueryDto, { status }),
      );
      const where = {
        tenantId,
        deletedAt: null,
        ...(status && { status }),
      };
      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where, skip: 0, take: 20 }),
      );
      expect(count).toHaveBeenCalledWith({ where });
    },
  );

  it.each(['createdFrom', 'createdTo'] as const)(
    'preserves single date boundary %s',
    async (key) => {
      const date = '2026-01-01T00:00:00.000Z';
      await service.list(
        tenantId,
        plainToInstance(ShipmentQueryDto, { [key]: date }),
      );
      expect(count).toHaveBeenCalledWith({
        where: {
          tenantId,
          deletedAt: null,
          createdAt: {
            [key === 'createdFrom' ? 'gte' : 'lte']: new Date(date),
          },
        },
      });
    },
  );

  it('rejects reversed dates without touching persistence', async () => {
    await expect(
      service.list(
        tenantId,
        plainToInstance(ShipmentQueryDto, {
          createdFrom: '2026-02-01',
          createdTo: '2026-01-01',
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(findMany).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
  });

  it('surfaces database failure rather than returning an empty success', async () => {
    findMany.mockRejectedValueOnce(new Error('query failed'));
    await expect(
      service.list(tenantId, new ShipmentQueryDto()),
    ).rejects.toThrow('query failed');
  });
});
