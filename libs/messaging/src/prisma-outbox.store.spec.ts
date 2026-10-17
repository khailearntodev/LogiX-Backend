import { describe, expect, it, vi } from 'vitest';
import { ServiceId } from '@logix/common';
import {
  PrismaOutboxStore,
  type OutboxDatabase,
} from './prisma-outbox.store.js';
import type { OutboxRelayRecord } from './outbox-relay.js';

describe('PrismaOutboxStore', () => {
  it('accepts the Fulfillment schema without widening the schema whitelist', () => {
    const database: OutboxDatabase = { $transaction: vi.fn() };
    expect(() => new PrismaOutboxStore(database, 'fulfillment', ServiceId.FULFILLMENT_SERVICE, 1000)).not.toThrow();
  });
  it('holds a SKIP LOCKED batch transaction through publishing and parameterizes writes', async () => {
    const tx = {
      $queryRawUnsafe: vi.fn().mockResolvedValue([
        {
          id: 'event-1',
          tenantId: 'tenant-1',
          eventType: 'StockReserved',
          eventVersion: 1,
          aggregateType: 'ReservationGroup',
          aggregateId: 'group-1',
          aggregateVersion: 2n,
          correlationId: 'correlation-1',
          causationId: null,
          payload: {},
          occurredAt: new Date('2026-10-11T00:00:00Z'),
          attemptCount: 0,
        },
      ]),
      $executeRawUnsafe: vi.fn().mockResolvedValue(1),
    };
    const transactionCalled = vi.fn();
    const database: OutboxDatabase = {
      $transaction: async (callback, options) => {
        transactionCalled(options);
        return callback(tx);
      },
    };
    const store = new PrismaOutboxStore(
      database,
      'inventory',
      ServiceId.INVENTORY_SERVICE,
      10000,
    );
    let received: OutboxRelayRecord[] = [];
    await store.withLockedBatch(5, async (records, transaction) => {
      received = records;
      await transaction.markPublished(records[0].id, new Date());
    });
    expect(tx.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('FOR UPDATE OF event SKIP LOCKED'),
      5,
    );
    expect(tx.$queryRawUnsafe.mock.calls[0][0]).toContain('AND NOT EXISTS');
    expect(received[0].envelope.eventId).toBe('event-1');
    expect(received[0].envelope.aggregateVersion).toBe(2);
    expect(received[0].envelope.actorId).toBeNull();
    expect(tx.$executeRawUnsafe.mock.calls[0][1]).toBe('event-1');
    expect(transactionCalled).toHaveBeenCalledWith({ timeout: 10000 });
  });
});
