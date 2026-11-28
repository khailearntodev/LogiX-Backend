import { randomUUID } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../database/prisma.service.js';
import { NotificationWriterService } from '../notifications/notification-writer.service.js';
import { BroadcastCommandService } from './broadcast-command.service.js';
import {
  BroadcastIdempotencyConflictError,
  hashBroadcastPayload,
} from './broadcast.types.js';

function makeConfig(): ConfigService {
  return {
    getOrThrow: vi.fn(() => 'notification.broadcast.requested.v1'),
  } as unknown as ConfigService;
}

describe('BroadcastCommandService', () => {
  it('creates notification, QUEUED broadcast, and outbox_events row atomically', async () => {
    const tenantId = randomUUID();
    const actorId = randomUUID();
    const idempotencyKey = randomUUID();
    const correlationId = randomUUID();
    const user1 = randomUUID();
    const user2 = randomUUID();
    const createdAt = new Date('2026-11-27T10:00:00.000Z');

    const tx = {
      notificationBroadcast: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
      },
      notification: {
        create: vi
          .fn()
          .mockImplementation(async ({ data }: { data: { id: string } }) => ({
            id: data.id,
            createdAt,
          })),
      },
      outboxEvent: {
        create: vi.fn().mockResolvedValue({}),
      },
    };
    const prisma = {
      notificationBroadcast: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (cb: (client: unknown) => Promise<unknown>) =>
        cb(tx),
      ),
    } as unknown as PrismaService;

    const service = new BroadcastCommandService(
      prisma,
      new NotificationWriterService(),
      makeConfig(),
    );

    const result = await service.enqueue({
      tenantId,
      actorId,
      idempotencyKey,
      correlationId,
      title: 'Bảo trì hệ thống',
      body: 'Hệ thống sẽ bảo trì lúc 23:00.',
      severity: 'INFO',
      audience: { kind: 'USERS', userIds: [user2, user1, user2] },
      link: '/settings',
    });

    expect(result).toEqual({
      id: expect.any(String),
      status: 'QUEUED',
      deduplicated: false,
    });
    expect(tx.notificationBroadcast.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: result.id,
        tenantId,
        createdBy: actorId,
        idempotencyKey,
        status: 'QUEUED',
        requestedCount: 2,
        resolvedCount: 0,
        audience: { kind: 'USERS', userIds: [user1, user2].sort() },
      }),
    });
    expect(tx.outboxEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId,
        topic: 'notification.broadcast.requested.v1',
        aggregateType: 'NotificationBroadcast',
        aggregateId: result.id,
        aggregateVersion: 1n,
        eventType: 'NotificationBroadcastRequested',
        eventVersion: 1,
        correlationId,
        payload: expect.objectContaining({
          broadcastId: result.id,
          tenantId,
          actorId,
          snapshotAt: createdAt.toISOString(),
        }),
      }),
    });
  });

  it('deduplicates repeated requests with matching idempotencyKey and payload hash', async () => {
    const broadcastId = randomUUID();
    const u1 = randomUUID();
    const u2 = randomUUID();
    const payloadHash = hashBroadcastPayload({
      title: 'Title',
      body: 'Body',
      severity: 'INFO',
      audience: { kind: 'USERS', userIds: [u1, u2] },
      link: null,
    });

    const prisma = {
      notificationBroadcast: {
        findUnique: vi.fn().mockResolvedValue({
          id: broadcastId,
          status: 'READY',
          payloadHash,
        }),
      },
      $transaction: vi.fn(),
    } as unknown as PrismaService;

    const service = new BroadcastCommandService(
      prisma,
      new NotificationWriterService(),
      makeConfig(),
    );

    await expect(
      service.enqueue({
        tenantId: randomUUID(),
        actorId: randomUUID(),
        idempotencyKey: randomUUID(),
        correlationId: randomUUID(),
        title: 'Title',
        body: 'Body',
        severity: 'INFO',
        audience: { kind: 'USERS', userIds: [u2, u1] },
        link: null,
      }),
    ).resolves.toEqual({
      id: broadcastId,
      status: 'READY',
      deduplicated: true,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('throws BroadcastIdempotencyConflictError when idempotencyKey is reused with a different payload', async () => {
    const prisma = {
      notificationBroadcast: {
        findUnique: vi.fn().mockResolvedValue({
          id: randomUUID(),
          status: 'QUEUED',
          payloadHash: 'different-hash',
        }),
      },
    } as unknown as PrismaService;

    const service = new BroadcastCommandService(
      prisma,
      new NotificationWriterService(),
      makeConfig(),
    );

    await expect(
      service.enqueue({
        tenantId: randomUUID(),
        actorId: randomUUID(),
        idempotencyKey: randomUUID(),
        correlationId: randomUUID(),
        title: 'Title',
        body: 'Body',
        severity: 'WARNING',
        audience: { kind: 'ALL' },
        link: null,
      }),
    ).rejects.toThrow(BroadcastIdempotencyConflictError);
  });

  it('handles concurrent P2002 race on ux_notification_broadcasts_idempotency safely', async () => {
    const existingId = randomUUID();
    const payloadHash = hashBroadcastPayload({
      title: 'Title',
      body: 'Body',
      severity: 'INFO',
      audience: { kind: 'ALL' },
      link: null,
    });
    const p2002 = new Prisma.PrismaClientKnownRequestError('Unique violation', {
      code: 'P2002',
      clientVersion: '7.10.0',
      meta: { target: 'ux_notification_broadcasts_idempotency' },
    });

    const findUnique = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: existingId,
        status: 'QUEUED',
        payloadHash,
      });

    const prisma = {
      notificationBroadcast: { findUnique },
      $transaction: vi.fn().mockRejectedValue(p2002),
    } as unknown as PrismaService;

    const service = new BroadcastCommandService(
      prisma,
      new NotificationWriterService(),
      makeConfig(),
    );

    await expect(
      service.enqueue({
        tenantId: randomUUID(),
        actorId: randomUUID(),
        idempotencyKey: randomUUID(),
        correlationId: randomUUID(),
        title: 'Title',
        body: 'Body',
        severity: 'INFO',
        audience: { kind: 'ALL' },
        link: null,
      }),
    ).resolves.toEqual({
      id: existingId,
      status: 'QUEUED',
      deduplicated: true,
    });
  });
});
