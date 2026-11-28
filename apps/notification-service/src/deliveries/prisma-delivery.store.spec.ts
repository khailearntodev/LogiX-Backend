import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../database/prisma.service.js';
import { PrismaDeliveryStore } from './prisma-delivery.store.js';

describe('PrismaDeliveryStore', () => {
  it('rejects invalid transaction timeouts', () => {
    const prisma = {} as PrismaService;
    expect(() => new PrismaDeliveryStore(prisma, 0)).toThrow(
      'Invalid delivery store transaction timeout',
    );
  });

  it('claims due IN_APP PENDING and RETRY jobs atomically with SKIP LOCKED and maps notification fields', async () => {
    const createdAt = new Date('2026-11-27T10:00:00.000Z');
    const tx = {
      $queryRawUnsafe: vi.fn().mockResolvedValue([
        {
          deliveryId: 'delivery-1',
          notificationRecipientId: 'recipient-1',
          attemptCount: 1,
          notificationId: 'notif-1',
          tenantId: 'tenant-1',
          recipientUserId: 'user-1',
          readAt: null,
          archivedAt: null,
          type: 'ORDER_PENDING_STOCK',
          title: 'Order pending stock',
          body: 'Order has shortages',
          severity: 'WARNING',
          entityType: 'SalesOrder',
          entityId: 'order-1',
          data: { orderId: 'order-1' },
          createdAt,
        },
      ]),
    };
    const txOptions = vi.fn();
    const prisma = {
      $transaction: vi.fn(async (cb: (client: unknown) => Promise<unknown>, opts: unknown) => {
        txOptions(opts);
        return cb(tx);
      }),
    } as unknown as PrismaService;

    const store = new PrismaDeliveryStore(prisma, 4000);
    const jobs = await store.claimInAppBatch(25, 'worker-1', 30000);

    expect(txOptions).toHaveBeenCalledWith({ timeout: 4000 });
    expect(tx.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('FOR UPDATE OF d SKIP LOCKED'),
      25,
      'worker-1',
      30000,
    );
    const sql = tx.$queryRawUnsafe.mock.calls[0][0] as string;
    expect(sql).toContain("d.status IN ('PENDING', 'RETRY')");
    expect(sql).toContain('d.next_attempt_at <= now()');
    expect(sql).toContain("SET status = 'PROCESSING'");
    expect(sql).toContain('locked_by = $2');
    expect(sql).toContain('locked_until = now() + ($3 * interval');

    expect(jobs).toEqual([
      {
        deliveryId: 'delivery-1',
        notificationRecipientId: 'recipient-1',
        notificationId: 'notif-1',
        tenantId: 'tenant-1',
        recipientUserId: 'user-1',
        attemptCount: 1,
        type: 'ORDER_PENDING_STOCK',
        title: 'Order pending stock',
        body: 'Order has shortages',
        severity: 'WARNING',
        entityType: 'SalesOrder',
        entityId: 'order-1',
        data: { orderId: 'order-1' },
        createdAt,
        readAt: null,
        archivedAt: null,
      },
    ]);
  });

  it('fences markSent, markRetry, and markFailed by PROCESSING and locked_by and clears leases', async () => {
    const executeRaw = vi
      .fn()
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1);
    const prisma = {
      $transaction: vi.fn(async (cb: (client: unknown) => Promise<unknown>) =>
        cb({ $executeRawUnsafe: executeRaw }),
      ),
    } as unknown as PrismaService;

    const store = new PrismaDeliveryStore(prisma, 5000);
    const sentAt = new Date('2026-11-27T10:05:00.000Z');
    const nextAttemptAt = new Date('2026-11-27T10:06:00.000Z');

    await expect(store.markSent('d-1', 'worker-1', sentAt)).resolves.toBe(true);
    await expect(store.markSent('d-1', 'worker-stale', sentAt)).resolves.toBe(
      false,
    );
    await expect(
      store.markRetry('d-2', 'worker-1', 2, nextAttemptAt, 'socket error'),
    ).resolves.toBe(true);
    await expect(
      store.markFailed('d-3', 'worker-1', 5, 'max attempts reached'),
    ).resolves.toBe(true);

    const sentSql = executeRaw.mock.calls[0][0] as string;
    expect(sentSql).toContain("SET status = 'SENT'");
    expect(sentSql).toContain('locked_by = NULL');
    expect(sentSql).toContain('locked_until = NULL');
    expect(sentSql).toContain("status = 'PROCESSING'");
    expect(sentSql).toContain('AND locked_by = $2');

    const retrySql = executeRaw.mock.calls[2][0] as string;
    expect(retrySql).toContain("SET status = 'RETRY'");
    expect(retrySql).toContain('locked_by = NULL');
    expect(retrySql).toContain('AND locked_by = $2');

    const failedSql = executeRaw.mock.calls[3][0] as string;
    expect(failedSql).toContain("SET status = 'FAILED'");
    expect(failedSql).toContain('locked_by = NULL');
    expect(failedSql).toContain('AND locked_by = $2');
  });

  it('reclaims expired PROCESSING leases into RETRY or FAILED atomically', async () => {
    const queryRaw = vi
      .fn()
      .mockResolvedValue([
        { status: 'RETRY' },
        { status: 'RETRY' },
        { status: 'FAILED' },
      ]);
    const prisma = {
      $transaction: vi.fn(async (cb: (client: unknown) => Promise<unknown>) =>
        cb({ $queryRawUnsafe: queryRaw }),
      ),
    } as unknown as PrismaService;

    const store = new PrismaDeliveryStore(prisma, 5000);
    const result = await store.reclaimExpiredLeases(5, 1000, 60000, 50);

    expect(queryRaw).toHaveBeenCalledWith(
      expect.stringContaining("d.status = 'PROCESSING'"),
      50,
      5,
      1000,
      60000,
    );
    const sql = queryRaw.mock.calls[0][0] as string;
    expect(sql).toContain('d.locked_until < now()');
    expect(sql).toContain('FOR UPDATE OF d SKIP LOCKED');
    expect(result).toEqual({ reclaimedToRetry: 2, markedFailed: 1 });
  });
});
