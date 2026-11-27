import { describe, expect, it, vi } from 'vitest';
import type { NotificationCoreService } from '../notifications/notification-core.service.js';
import { PermanentDeliveryError } from './delivery.errors.js';
import {
  deliveryRetryDelay,
  InAppDeliveryWorker,
  type InAppDeliveryWorkerOptions,
} from './in-app-delivery.worker.js';
import type {
  ClaimedDeliveryJob,
  DeliveryStore,
} from './prisma-delivery.store.js';

const baseOptions: InAppDeliveryWorkerOptions = {
  enabled: true,
  pollIntervalMs: 500,
  batchSize: 50,
  concurrency: 3,
  leaseMs: 30_000,
  maxAttempts: 5,
  retryBaseMs: 1_000,
  retryMaxMs: 60_000,
  reclaimIntervalMs: 15_000,
  workerId: 'worker-1',
};

function makeJob(
  overrides: Partial<ClaimedDeliveryJob> = {},
): ClaimedDeliveryJob {
  return {
    deliveryId: 'delivery-1',
    notificationRecipientId: 'recipient-1',
    notificationId: 'notif-1',
    tenantId: 'tenant-1',
    recipientUserId: 'user-1',
    attemptCount: 0,
    type: 'ORDER_PENDING_STOCK',
    title: 'Order pending',
    body: 'Shortage detected',
    severity: 'WARNING',
    entityType: 'SalesOrder',
    entityId: 'order-1',
    data: { orderId: 'order-1' },
    createdAt: new Date('2026-11-27T10:00:00.000Z'),
    readAt: null,
    archivedAt: null,
    ...overrides,
  };
}

function createFixture(jobs: ClaimedDeliveryJob[] = [makeJob()]) {
  const events: string[] = [];
  const store: DeliveryStore = {
    claimInAppBatch: vi.fn().mockResolvedValue(jobs),
    loadUnreadCounts: vi
      .fn()
      .mockResolvedValue(new Map([['user-1', 4], ['user-2', 2]])),
    markSent: vi.fn(async (id: string) => {
      events.push(`markSent:${id}`);
      return true;
    }),
    markRetry: vi.fn(async (id: string) => {
      events.push(`markRetry:${id}`);
      return true;
    }),
    markFailed: vi.fn(async (id: string) => {
      events.push(`markFailed:${id}`);
      return true;
    }),
    reclaimExpiredLeases: vi
      .fn()
      .mockResolvedValue({ reclaimedToRetry: 1, markedFailed: 0 }),
  };

  const core: Pick<NotificationCoreService, 'dispatchInApp'> = {
    dispatchInApp: vi.fn(async (context) => {
      events.push(`dispatch:${context.recipientUserId}`);
      return { status: 'EMITTED' as const };
    }),
  };

  return {
    events,
    store,
    core,
    worker: new InAppDeliveryWorker(store, core, baseOptions),
  };
}

describe('InAppDeliveryWorker', () => {
  it('marks SENT strictly after dispatchInApp succeeds with resolved link and unreadCount', async () => {
    const job = makeJob();
    const { events, store, core, worker } = createFixture([job]);

    const processed = await worker.processBatch();

    expect(processed).toBe(1);
    expect(events).toEqual(['dispatch:user-1', 'markSent:delivery-1']);
    expect(core.dispatchInApp).toHaveBeenCalledWith({
      notificationId: 'notif-1',
      tenantId: 'tenant-1',
      recipientUserId: 'user-1',
      unreadCount: 4,
      payload: {
        id: 'notif-1',
        tenantId: 'tenant-1',
        type: 'ORDER_PENDING_STOCK',
        title: 'Order pending',
        body: 'Shortage detected',
        link: '/orders/order-1',
        severity: 'WARNING',
        entityType: 'SalesOrder',
        entityId: 'order-1',
        data: { orderId: 'order-1' },
        createdAt: '2026-11-27T10:00:00.000Z',
        readAt: null,
        archivedAt: null,
      },
    });
    expect(store.markSent).toHaveBeenCalledWith(
      'delivery-1',
      'worker-1',
      expect.any(Date),
    );
  });

  it('bounds simultaneous dispatchInApp calls by configured concurrency', async () => {
    const jobs = Array.from({ length: 6 }, (_, index) =>
      makeJob({
        deliveryId: `delivery-${index}`,
        recipientUserId: `user-${index}`,
      }),
    );
    const { store, core } = createFixture(jobs);
    let inFlight = 0;
    let maxInFlight = 0;

    vi.mocked(core.dispatchInApp).mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 15));
      inFlight -= 1;
      return { status: 'EMITTED' };
    });

    const worker = new InAppDeliveryWorker(store, core, {
      ...baseOptions,
      concurrency: 2,
    });
    const processed = await worker.processBatch();

    expect(processed).toBe(6);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(store.markSent).toHaveBeenCalledTimes(6);
  });

  it('marks RETRY on transient dispatch error while sibling jobs still succeed', async () => {
    const jobs = [
      makeJob({ deliveryId: 'd-fail', recipientUserId: 'user-1', attemptCount: 1 }),
      makeJob({ deliveryId: 'd-ok', recipientUserId: 'user-2', attemptCount: 0 }),
    ];
    const { store, core, worker } = createFixture(jobs);
    vi.mocked(core.dispatchInApp)
      .mockRejectedValueOnce(new Error('socket down'))
      .mockResolvedValueOnce({ status: 'EMITTED' });

    const processed = await worker.processBatch();

    expect(processed).toBe(2);
    expect(store.markRetry).toHaveBeenCalledWith(
      'd-fail',
      'worker-1',
      2,
      expect.any(Date),
      'socket down',
    );
    expect(store.markSent).toHaveBeenCalledWith(
      'd-ok',
      'worker-1',
      expect.any(Date),
    );
    expect(store.markFailed).not.toHaveBeenCalled();
  });

  it('marks FAILED when maxAttempts is reached or PermanentDeliveryError is thrown', async () => {
    const jobs = [
      makeJob({ deliveryId: 'd-max', recipientUserId: 'user-1', attemptCount: 4 }),
      makeJob({ deliveryId: 'd-perm', recipientUserId: 'user-2', attemptCount: 0 }),
    ];
    const { store, core, worker } = createFixture(jobs);
    vi.mocked(core.dispatchInApp)
      .mockRejectedValueOnce(new Error('transient error'))
      .mockRejectedValueOnce(new PermanentDeliveryError('invalid channel state'));

    await worker.processBatch();

    expect(store.markFailed).toHaveBeenCalledWith(
      'd-max',
      'worker-1',
      5,
      'transient error',
    );
    expect(store.markFailed).toHaveBeenCalledWith(
      'd-perm',
      'worker-1',
      1,
      'invalid channel state',
    );
    expect(store.markRetry).not.toHaveBeenCalled();
  });

  it('continues delivery with undefined unreadCount if loadUnreadCounts fails', async () => {
    const { store, core, worker } = createFixture([makeJob()]);
    vi.mocked(store.loadUnreadCounts).mockRejectedValueOnce(new Error('db blip'));

    await worker.processBatch();

    expect(core.dispatchInApp).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientUserId: 'user-1',
        unreadCount: undefined,
      }),
    );
    expect(store.markSent).toHaveBeenCalledOnce();
  });

  it('delegates expired lease reclamation to store', async () => {
    const { store, worker } = createFixture();
    await expect(worker.reclaimExpired()).resolves.toEqual({
      reclaimedToRetry: 1,
      markedFailed: 0,
    });
    expect(store.reclaimExpiredLeases).toHaveBeenCalledWith(5, 1000, 60000, 50);
  });

  it('caps exponential retry delay and rejects invalid options', () => {
    expect([1, 2, 3, 10].map((n) => deliveryRetryDelay(n, 100, 1000))).toEqual([
      100, 200, 400, 1000,
    ]);

    const { store, core } = createFixture();
    expect(
      () =>
        new InAppDeliveryWorker(store, core, {
          ...baseOptions,
          retryMaxMs: 50,
          retryBaseMs: 100,
        }),
    ).toThrow('Invalid in-app delivery worker configuration');
    expect(
      () =>
        new InAppDeliveryWorker(store, core, {
          ...baseOptions,
          concurrency: 0,
        }),
    ).toThrow('Invalid in-app delivery worker configuration');
  });
});
