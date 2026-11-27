import { ServiceId } from '@logix/common';
import { describe, expect, it, vi } from 'vitest';
import { PrismaClaimLeaseOutboxStore } from './prisma-claim-lease-outbox.store.js';
import type { OutboxDatabase } from './prisma-outbox.store.js';

describe('PrismaClaimLeaseOutboxStore', () => {
  it('accepts identity and notification schemas while rejecting legacy or unsafe schemas', () => {
    const database: OutboxDatabase = { $transaction: vi.fn() };
    expect(
      () =>
        new PrismaClaimLeaseOutboxStore(
          database,
          'identity',
          ServiceId.IDENTITY_SERVICE,
          3000,
        ),
    ).not.toThrow();
    expect(
      () =>
        new PrismaClaimLeaseOutboxStore(
          database,
          'notification',
          ServiceId.NOTIFICATION_SERVICE,
          3000,
        ),
    ).not.toThrow();
    expect(() =>
      Reflect.construct(PrismaClaimLeaseOutboxStore, [
        database,
        'orders',
        ServiceId.ORDER_SERVICE,
        3000,
      ]),
    ).toThrow('Invalid claim-lease outbox store configuration');
    expect(() =>
      Reflect.construct(PrismaClaimLeaseOutboxStore, [
        database,
        'identity; DROP SCHEMA identity',
        ServiceId.IDENTITY_SERVICE,
        3000,
      ]),
    ).toThrow('Invalid claim-lease outbox store configuration');
  });

  it('claims eligible rows atomically with SKIP LOCKED, lease expiry, IS NOT DISTINCT FROM, and nullable tenantId', async () => {
    const occurredAt = new Date('2026-11-26T10:00:00.000Z');
    const tx = {
      $queryRawUnsafe: vi.fn().mockResolvedValue([
        {
          id: 'event-1',
          tenantId: null,
          topic: 'notification.email.requested.v1',
          eventType: 'TransactionalEmailRequested',
          eventVersion: 1,
          aggregateType: 'ContactLead',
          aggregateId: 'lead-1',
          aggregateVersion: 1n,
          correlationId: 'corr-1',
          causationId: null,
          payload: { messageId: 'msg-1', actorId: 'admin-1' },
          occurredAt,
          attemptCount: 2,
        },
      ]),
      $executeRawUnsafe: vi.fn(),
    };
    const transactionOptions = vi.fn();
    const database: OutboxDatabase = {
      $transaction: async (callback, options) => {
        transactionOptions(options);
        return callback(tx);
      },
    };
    const store = new PrismaClaimLeaseOutboxStore(
      database,
      'identity',
      ServiceId.IDENTITY_SERVICE,
      2500,
    );

    const records = await store.claimBatch(25, 'worker-1', 15000);

    expect(transactionOptions).toHaveBeenCalledWith({ timeout: 2500 });
    expect(tx.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('FOR UPDATE OF event SKIP LOCKED'),
      25,
      'worker-1',
      15000,
    );
    const sql = tx.$queryRawUnsafe.mock.calls[0][0] as string;
    expect(sql).toContain('FROM identity.outbox_events AS event');
    expect(sql).toContain('earlier.tenant_id IS NOT DISTINCT FROM event.tenant_id');
    expect(sql).toContain('(event.locked_until IS NULL OR event.locked_until < now())');
    expect(sql).toContain('UPDATE identity.outbox_events AS target');
    expect(sql).toContain('RETURNING');

    expect(records).toEqual([
      {
        id: 'event-1',
        topic: 'notification.email.requested.v1',
        attemptCount: 2,
        envelope: {
          eventId: 'event-1',
          eventType: 'TransactionalEmailRequested',
          eventVersion: 1,
          occurredAt: occurredAt.toISOString(),
          producer: ServiceId.IDENTITY_SERVICE,
          tenantId: null,
          actorId: 'admin-1',
          correlationId: 'corr-1',
          causationId: 'corr-1',
          aggregateType: 'ContactLead',
          aggregateId: 'lead-1',
          aggregateVersion: 1,
          payload: { messageId: 'msg-1', actorId: 'admin-1' },
        },
      },
    ]);
  });

  it('clears lease fields and scopes markPublished and markFailed by locked_by', async () => {
    const tx = {
      $queryRawUnsafe: vi.fn(),
      $executeRawUnsafe: vi.fn().mockResolvedValue(1),
    };
    const database: OutboxDatabase = {
      $transaction: async (callback) => callback(tx),
    };
    const store = new PrismaClaimLeaseOutboxStore(
      database,
      'notification',
      ServiceId.NOTIFICATION_SERVICE,
      2000,
    );

    const publishedAt = new Date('2026-11-26T10:01:00.000Z');
    await store.markPublished('event-1', 'worker-1', publishedAt);

    expect(tx.$executeRawUnsafe).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('locked_by = NULL'),
      'event-1',
      'worker-1',
      publishedAt,
    );
    expect(tx.$executeRawUnsafe.mock.calls[0][0]).toContain(
      'UPDATE notification.outbox_events',
    );
    expect(tx.$executeRawUnsafe.mock.calls[0][0]).toContain(
      'AND locked_by = $2',
    );

    const nextAttemptAt = new Date('2026-11-26T10:02:00.000Z');
    await store.markFailed(
      'event-2',
      'worker-1',
      3,
      nextAttemptAt,
      'Kafka timeout',
    );

    expect(tx.$executeRawUnsafe).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('locked_until = NULL'),
      'event-2',
      'worker-1',
      3,
      nextAttemptAt,
      'Kafka timeout',
    );
    expect(tx.$executeRawUnsafe.mock.calls[1][0]).toContain(
      'AND locked_by = $2',
    );
  });
});
