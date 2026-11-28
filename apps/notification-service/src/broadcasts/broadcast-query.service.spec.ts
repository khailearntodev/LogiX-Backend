import { randomUUID } from 'node:crypto';
import { EntityNotFoundError, ValidationError } from '@logix/errors';
import type { PrismaService } from '../database/prisma.service.js';
import { BroadcastQueryService } from './broadcast-query.service.js';

describe('BroadcastQueryService', () => {
  it('lists tenant-scoped broadcasts with cursor pagination and aggregated delivered/read counts', async () => {
    const tenantId = randomUUID();
    const b1 = randomUUID();
    const b2 = randomUUID();
    const n1 = randomUUID();
    const n2 = randomUUID();
    const senderId = randomUUID();
    const t1 = new Date('2026-11-27T11:00:00.000Z');
    const t2 = new Date('2026-11-27T10:00:00.000Z');

    const findMany = vi.fn().mockResolvedValue([
      {
        id: b1,
        notificationId: n1,
        createdBy: senderId,
        audience: { kind: 'ALL' },
        status: 'COMPLETED',
        resolvedCount: 10,
        createdAt: t1,
        completedAt: new Date('2026-11-27T11:01:00.000Z'),
        lastError: null,
        notification: { title: 'B1', severity: 'INFO' },
      },
      {
        id: b2,
        notificationId: n2,
        createdBy: senderId,
        audience: { kind: 'ALL' },
        status: 'READY',
        resolvedCount: 5,
        createdAt: t2,
        completedAt: null,
        lastError: null,
        notification: { title: 'B2', severity: 'WARNING' },
      },
    ]);
    const groupBy = vi
      .fn()
      .mockResolvedValue([{ notificationId: n1, _count: { _all: 4 } }]);
    const queryRawUnsafe = vi
      .fn()
      .mockResolvedValue([{ notificationId: n1, deliveredCount: 9n }]);

    const prisma = {
      notificationBroadcast: { findMany },
      notificationRecipient: { groupBy },
      $queryRawUnsafe: queryRawUnsafe,
    } as unknown as PrismaService;

    const service = new BroadcastQueryService(prisma);
    const result = await service.list(tenantId, { limit: 1 });

    expect(result.items).toEqual([
      {
        id: b1,
        title: 'B1',
        severity: 'INFO',
        audience: { kind: 'ALL' },
        senderId,
        status: 'COMPLETED',
        recipientCount: 10,
        deliveredCount: 9,
        readCount: 4,
        createdAt: t1.toISOString(),
        completedAt: '2026-11-27T11:01:00.000Z',
      },
    ]);
    expect(result.nextCursor).toBeTruthy();

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId, deletedAt: null },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 2,
      }),
    );

    await expect(
      service.list(tenantId, { limit: 10, cursor: 'invalid-cursor!' }),
    ).rejects.toThrow(ValidationError);
  });

  it('throws EntityNotFoundError when broadcast is missing or belongs to another tenant', async () => {
    const prisma = {
      notificationBroadcast: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    } as unknown as PrismaService;
    const service = new BroadcastQueryService(prisma);

    await expect(
      service.getById(randomUUID(), randomUUID()),
    ).rejects.toThrow(EntityNotFoundError);
  });

  it('reconciles READY broadcasts whose deliveries are all terminal into COMPLETED and PARTIAL_FAILED', async () => {
    const queryRawUnsafe = vi
      .fn()
      .mockResolvedValue([{ status: 'COMPLETED' }, { status: 'PARTIAL_FAILED' }]);
    const prisma = {
      $queryRawUnsafe: queryRawUnsafe,
    } as unknown as PrismaService;
    const service = new BroadcastQueryService(prisma);

    await expect(service.reconcileReadyBroadcasts(25)).resolves.toEqual({
      completed: 1,
      partialFailed: 1,
    });
    expect(queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining("WHERE b.status = 'READY'"),
      25,
    );
  });
});
