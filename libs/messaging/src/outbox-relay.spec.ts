import { describe, expect, it, vi } from 'vitest';
import {
  OutboxRelay,
  outboxRetryDelay,
  type OutboxRelayRecord,
  type OutboxRelayStore,
} from './outbox-relay.js';
import type { DomainEventEnvelope } from './event-envelope.js';
import { ServiceId } from '@logix/common';

const envelope: DomainEventEnvelope = {
  eventId: 'event-1',
  aggregateId: 'order-1',
  correlationId: 'correlation-1',
  eventType: 'OrderCreated',
  eventVersion: 1,
  occurredAt: new Date().toISOString(),
  producer: ServiceId.ORDER_SERVICE,
  tenantId: 'tenant-1',
  actorId: 'actor-1',
  causationId: 'correlation-1',
  aggregateType: 'SalesOrder',
  aggregateVersion: 1,
  payload: {},
};
const options = {
  topic: 'test-topic',
  intervalMs: 10,
  batchSize: 10,
  retryBaseMs: 100,
  retryMaxMs: 1000,
};

function fixture() {
  const records: OutboxRelayRecord[] = [
    { id: 'event-1', attemptCount: 0, envelope },
  ];
  const tx = {
    markPublished: vi.fn().mockResolvedValue(undefined),
    markFailed: vi.fn().mockResolvedValue(undefined),
  };
  const producer = { publishRaw: vi.fn().mockResolvedValue(undefined) };
  const store = {
    withLockedBatch: vi.fn<OutboxRelayStore['withLockedBatch']>(
      async (_size, callback) => callback(records, tx),
    ),
  };
  return {
    tx,
    producer,
    store,
    relay: new OutboxRelay(store, producer, options),
  };
}

describe('OutboxRelay', () => {
  it('publishes the persisted envelope without generating a new eventId', async () => {
    const { relay, tx, producer } = fixture();
    await relay.flush();
    expect(producer.publishRaw).toHaveBeenCalledWith(options.topic, envelope);
    expect(tx.markPublished).toHaveBeenCalledWith(
      envelope.eventId,
      expect.any(Date),
    );
    expect(tx.markFailed).not.toHaveBeenCalled();
  });

  it('records a failed publish and schedules backoff without marking success', async () => {
    const { relay, tx, producer } = fixture();
    producer.publishRaw.mockRejectedValue(new Error('broker unavailable'));
    await relay.flush();
    expect(tx.markFailed).toHaveBeenCalledWith(
      envelope.eventId,
      1,
      expect.any(Date),
      'broker unavailable',
    );
    expect(tx.markPublished).not.toHaveBeenCalled();
  });

  it('propagates database errors after publish instead of hiding them', async () => {
    const { relay, tx } = fixture();
    tx.markPublished.mockRejectedValue(new Error('commit failed'));
    await expect(relay.flush()).rejects.toThrow('commit failed');
    expect(tx.markFailed).not.toHaveBeenCalled();
  });

  it('caps exponential backoff', () => {
    expect([1, 2, 3, 10].map((n) => outboxRetryDelay(n, 100, 1000))).toEqual([
      100, 200, 400, 1000,
    ]);
  });

  it('rejects invalid configuration', () => {
    const { store, producer } = fixture();
    expect(
      () => new OutboxRelay(store, producer, { ...options, topic: '' }),
    ).toThrow();
    expect(
      () => new OutboxRelay(store, producer, { ...options, batchSize: 0 }),
    ).toThrow();
  });
});
