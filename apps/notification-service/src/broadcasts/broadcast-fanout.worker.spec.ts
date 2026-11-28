import { randomUUID } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import type { DomainEventEnvelope } from '@logix/messaging';
import type { PrismaService } from '../database/prisma.service.js';
import type { InAppDeliveryWorker } from '../deliveries/in-app-delivery.worker.js';
import type { IdentityRecipientClient } from '../integrations/identity-recipient.client.js';
import type { NotificationWriterService } from '../notifications/notification-writer.service.js';
import { BroadcastFanoutWorker } from './broadcast-fanout.worker.js';

function makeConfig(maxRecipients = 5000, batchSize = 2): ConfigService {
  const values: Record<string, number> = {
    MAX_BROADCAST_RECIPIENTS: maxRecipients,
    BROADCAST_FANOUT_BATCH_SIZE: batchSize,
  };
  return {
    get: vi.fn((key: string) => values[key]),
  } as unknown as ConfigService;
}

function makeEvent(
  overrides: Partial<DomainEventEnvelope> = {},
): DomainEventEnvelope {
  const tenantId = randomUUID();
  const broadcastId = randomUUID();
  const notificationId = randomUUID();
  const actorId = randomUUID();
  const timestamp = '2026-11-27T10:00:00.000Z';

  return {
    eventId: randomUUID(),
    eventType: 'NotificationBroadcastRequested',
    eventVersion: 1,
    occurredAt: timestamp,
    producer: 'notification-service',
    tenantId,
    actorId,
    correlationId: randomUUID(),
    causationId: randomUUID(),
    aggregateType: 'NotificationBroadcast',
    aggregateId: broadcastId,
    aggregateVersion: 1,
    payload: {
      broadcastId,
      notificationId,
      tenantId,
      actorId,
      audience: { kind: 'ALL' },
      snapshotAt: timestamp,
      requestedAt: timestamp,
    },
    ...overrides,
  };
}

describe('BroadcastFanoutWorker', () => {
  it('ignores unrelated events and invalid command payloads without DB updates', async () => {
    const prisma = { $transaction: vi.fn() } as unknown as PrismaService;
    const recipients = { resolvePage: vi.fn() } as unknown as IdentityRecipientClient;
    const writer = {
      attachInAppRecipientsBatch: vi.fn(),
    } as unknown as NotificationWriterService;
    const worker = new BroadcastFanoutWorker(
      prisma,
      recipients,
      writer,
      makeConfig(),
    );

    await expect(
      worker.handle(makeEvent({ eventType: 'OrderCreated' })),
    ).resolves.toEqual({ outcome: 'IGNORED' });
    await expect(
      worker.handle(makeEvent({ payload: { invalid: true } })),
    ).resolves.toEqual({ outcome: 'INVALID' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('skips broadcasts already marked READY or FAILED', async () => {
    const prisma = {
      $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
        cb({
          notificationBroadcast: {
            updateMany: vi.fn().mockResolvedValue({ count: 0 }),
          },
        }),
      ),
    } as unknown as PrismaService;
    const recipients = { resolvePage: vi.fn() } as unknown as IdentityRecipientClient;
    const writer = {
      attachInAppRecipientsBatch: vi.fn(),
    } as unknown as NotificationWriterService;
    const worker = new BroadcastFanoutWorker(
      prisma,
      recipients,
      writer,
      makeConfig(),
    );

    await expect(worker.handle(makeEvent())).resolves.toEqual({
      outcome: 'SKIPPED',
    });
    expect(recipients.resolvePage).not.toHaveBeenCalled();
  });

  it('fails cleanly with MAX_RECIPIENTS_EXCEEDED before persisting any recipients', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
        cb({ notificationBroadcast: { updateMany } }),
      ),
      notificationBroadcast: { updateMany },
    } as unknown as PrismaService;
    const u1 = randomUUID();
    const u2 = randomUUID();
    const u3 = randomUUID();
    const recipients = {
      resolvePage: vi.fn().mockResolvedValue({
        userIds: [u1, u2, u3],
        nextCursor: null,
        hasMore: false,
      }),
    } as unknown as IdentityRecipientClient;
    const writer = {
      attachInAppRecipientsBatch: vi.fn(),
    } as unknown as NotificationWriterService;
    const deliveryWorker = { wakeUp: vi.fn() } as unknown as InAppDeliveryWorker;

    const worker = new BroadcastFanoutWorker(
      prisma,
      recipients,
      writer,
      makeConfig(2, 500),
      deliveryWorker,
    );

    await expect(worker.handle(makeEvent())).resolves.toEqual({
      outcome: 'FAILED',
      reason: 'MAX_RECIPIENTS_EXCEEDED',
    });
    expect(writer.attachInAppRecipientsBatch).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'FAILED',
          resolvedCount: 0,
          lastError: 'MAX_RECIPIENTS_EXCEEDED',
          completedAt: expect.any(Date),
        }),
      }),
    );
    expect(deliveryWorker.wakeUp).not.toHaveBeenCalled();
  });

  it('marks NO_RECIPIENTS as FAILED when resolved audience is empty', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
        cb({ notificationBroadcast: { updateMany } }),
      ),
      notificationBroadcast: { updateMany },
    } as unknown as PrismaService;
    const recipients = {
      resolvePage: vi.fn().mockResolvedValue({
        userIds: [],
        nextCursor: null,
        hasMore: false,
      }),
    } as unknown as IdentityRecipientClient;
    const writer = {
      attachInAppRecipientsBatch: vi.fn(),
    } as unknown as NotificationWriterService;

    const worker = new BroadcastFanoutWorker(
      prisma,
      recipients,
      writer,
      makeConfig(),
    );

    await expect(worker.handle(makeEvent())).resolves.toEqual({
      outcome: 'FAILED',
      reason: 'NO_RECIPIENTS',
    });
    expect(writer.attachInAppRecipientsBatch).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'FAILED',
          lastError: 'NO_RECIPIENTS',
        }),
      }),
    );
  });

  it('resolves paginated recipients, inserts batches of PENDING deliveries, marks READY, and wakes DeliveryWorker', async () => {
    const u1 = randomUUID();
    const u2 = randomUUID();
    const u3 = randomUUID();
    const event = makeEvent();
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
        cb({ notificationBroadcast: { updateMany } }),
      ),
      notificationBroadcast: { updateMany },
    } as unknown as PrismaService;

    const recipients = {
      resolvePage: vi
        .fn()
        .mockResolvedValueOnce({
          userIds: [u1, u2],
          nextCursor: u2,
          hasMore: true,
        })
        .mockResolvedValueOnce({
          userIds: [u3],
          nextCursor: null,
          hasMore: false,
        }),
    } as unknown as IdentityRecipientClient;

    const attachInAppRecipientsBatch = vi
      .fn()
      .mockResolvedValue({ recipientCount: 2, deliveryCount: 2 });
    const writer = {
      attachInAppRecipientsBatch,
    } as unknown as NotificationWriterService;
    const deliveryWorker = { wakeUp: vi.fn() } as unknown as InAppDeliveryWorker;

    const worker = new BroadcastFanoutWorker(
      prisma,
      recipients,
      writer,
      makeConfig(5000, 2),
      deliveryWorker,
    );

    await expect(worker.handle(event)).resolves.toEqual({
      outcome: 'READY',
      resolvedCount: 3,
    });
    expect(attachInAppRecipientsBatch).toHaveBeenCalledTimes(2);
    expect(attachInAppRecipientsBatch).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({
        tenantId: event.tenantId,
        recipientUserIds: [u1, u2],
      }),
    );
    expect(attachInAppRecipientsBatch).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({
        tenantId: event.tenantId,
        recipientUserIds: [u3],
      }),
    );
    expect(updateMany).toHaveBeenLastCalledWith({
      where: {
        id: event.aggregateId,
        tenantId: event.tenantId,
        deletedAt: null,
      },
      data: {
        status: 'READY',
        resolvedCount: 3,
        lastError: null,
        version: { increment: 1 },
      },
    });
    expect(deliveryWorker.wakeUp).toHaveBeenCalledOnce();
  });

  it('propagates transient identity errors so Kafka keeps broadcast offset retryable', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
        cb({ notificationBroadcast: { updateMany } }),
      ),
      notificationBroadcast: { updateMany },
    } as unknown as PrismaService;
    const recipients = {
      resolvePage: vi.fn().mockRejectedValue(new Error('HTTP 503')),
    } as unknown as IdentityRecipientClient;
    const writer = {
      attachInAppRecipientsBatch: vi.fn(),
    } as unknown as NotificationWriterService;

    const worker = new BroadcastFanoutWorker(
      prisma,
      recipients,
      writer,
      makeConfig(),
    );

    await expect(worker.handle(makeEvent())).rejects.toThrow('HTTP 503');
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(writer.attachInAppRecipientsBatch).not.toHaveBeenCalled();
  });
});
