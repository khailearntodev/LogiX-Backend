import { ServiceId } from '@logix/common';
import { describe, expect, it, vi } from 'vitest';
import {
  ClaimLeaseOutboxRelay,
  type ClaimedOutboxRecord,
  type ClaimLeaseOutboxRelayOptions,
  type ClaimLeaseOutboxStore,
} from './claim-lease-outbox-relay.js';
import type { CommandEventEnvelope } from './event-envelope.js';

function makeEnvelope(
  overrides: Partial<CommandEventEnvelope> = {},
): CommandEventEnvelope {
  return {
    eventId: 'event-1',
    eventType: 'TransactionalEmailRequested',
    eventVersion: 1,
    occurredAt: new Date('2026-11-26T10:00:00.000Z').toISOString(),
    producer: ServiceId.IDENTITY_SERVICE,
    tenantId: 'tenant-1',
    actorId: 'actor-1',
    correlationId: 'correlation-1',
    causationId: 'correlation-1',
    aggregateType: 'ContactLead',
    aggregateId: 'lead-1',
    aggregateVersion: 1,
    payload: { messageId: 'msg-1', secretToken: 'never-log-me' },
    ...overrides,
  };
}

const baseOptions: ClaimLeaseOutboxRelayOptions = {
  defaultTopic: 'notification.email.requested.v1',
  workerId: 'worker-1',
  intervalMs: 100,
  batchSize: 10,
  leaseMs: 5000,
  publishTimeoutMs: 1000,
  retryBaseMs: 100,
  retryMaxMs: 1000,
};

function fixture(records: ClaimedOutboxRecord[] = []) {
  const defaultRecords: ClaimedOutboxRecord[] =
    records.length > 0
      ? records
      : [
          {
            id: 'event-1',
            topic: 'notification.email.requested.v1',
            attemptCount: 0,
            envelope: makeEnvelope(),
          },
        ];

  const events: string[] = [];
  const store: ClaimLeaseOutboxStore = {
    claimBatch: vi.fn(async () => {
      events.push('claim:start');
      events.push('claim:commit');
      return defaultRecords;
    }),
    markPublished: vi.fn(async (id: string) => {
      events.push(`markPublished:${id}`);
    }),
    markFailed: vi.fn(async (id: string) => {
      events.push(`markFailed:${id}`);
    }),
  };

  const producer = {
    publishRaw: vi.fn(async (_topic: string, envelope: CommandEventEnvelope) => {
      events.push(`publish:${envelope.eventId}`);
    }),
  };

  return {
    events,
    store,
    producer,
    relay: new ClaimLeaseOutboxRelay(store, producer, baseOptions),
  };
}

describe('ClaimLeaseOutboxRelay', () => {
  it('claims and commits before publishing outside any DB transaction, including tenantless envelopes', async () => {
    const tenantless = makeEnvelope({ eventId: 'event-null', tenantId: null });
    const { events, store, producer, relay } = fixture([
      {
        id: 'event-null',
        topic: 'notification.email.requested.v1',
        attemptCount: 0,
        envelope: tenantless,
      },
    ]);

    const count = await relay.flush();

    expect(count).toBe(1);
    expect(events).toEqual([
      'claim:start',
      'claim:commit',
      'publish:event-null',
      'markPublished:event-null',
    ]);
    expect(store.claimBatch).toHaveBeenCalledWith(10, 'worker-1', 5000);
    expect(producer.publishRaw).toHaveBeenCalledWith(
      'notification.email.requested.v1',
      tenantless,
    );
    expect(store.markPublished).toHaveBeenCalledWith(
      'event-null',
      'worker-1',
      expect.any(Date),
    );
    expect(store.markFailed).not.toHaveBeenCalled();
  });

  it('routes to per-record topic and falls back to defaultTopic when record topic is blank', async () => {
    const first = makeEnvelope({ eventId: 'event-1' });
    const second = makeEnvelope({ eventId: 'event-2' });
    const { producer, store, relay } = fixture([
      {
        id: 'event-1',
        topic: 'notification.broadcast.requested.v1',
        attemptCount: 0,
        envelope: first,
      },
      {
        id: 'event-2',
        topic: '   ',
        attemptCount: 0,
        envelope: second,
      },
    ]);

    await relay.flush();

    expect(producer.publishRaw).toHaveBeenNthCalledWith(
      1,
      'notification.broadcast.requested.v1',
      first,
    );
    expect(producer.publishRaw).toHaveBeenNthCalledWith(
      2,
      'notification.email.requested.v1',
      second,
    );
    expect(store.markPublished).toHaveBeenCalledTimes(2);
  });

  it('marks missing topic as failed without calling producer', async () => {
    const { producer, store } = fixture([
      {
        id: 'event-no-topic',
        topic: '',
        attemptCount: 0,
        envelope: makeEnvelope({ eventId: 'event-no-topic' }),
      },
    ]);
    const relay = new ClaimLeaseOutboxRelay(store, producer, {
      ...baseOptions,
      defaultTopic: undefined,
    });

    await relay.flush();

    expect(producer.publishRaw).not.toHaveBeenCalled();
    expect(store.markFailed).toHaveBeenCalledWith(
      'event-no-topic',
      'worker-1',
      1,
      expect.any(Date),
      'Outbox record topic is missing',
    );
  });

  it('schedules retry on publish failure and continues processing the rest of the batch', async () => {
    const first = makeEnvelope({ eventId: 'event-1' });
    const second = makeEnvelope({ eventId: 'event-2' });
    const { producer, store, relay } = fixture([
      {
        id: 'event-1',
        topic: 'notification.email.requested.v1',
        attemptCount: 1,
        envelope: first,
      },
      {
        id: 'event-2',
        topic: 'notification.email.requested.v1',
        attemptCount: 0,
        envelope: second,
      },
    ]);
    producer.publishRaw
      .mockRejectedValueOnce(new Error('broker unavailable'))
      .mockResolvedValueOnce(undefined);

    const count = await relay.flush();

    expect(count).toBe(2);
    expect(store.markFailed).toHaveBeenCalledWith(
      'event-1',
      'worker-1',
      2,
      expect.any(Date),
      'broker unavailable',
    );
    expect(store.markPublished).toHaveBeenCalledTimes(1);
    expect(store.markPublished).toHaveBeenCalledWith(
      'event-2',
      'worker-1',
      expect.any(Date),
    );
  });

  it('times out stalled publish attempts cleanly and marks them failed', async () => {
    const { producer, store } = fixture();
    producer.publishRaw.mockImplementation(
      () => new Promise<void>(() => undefined),
    );
    const relay = new ClaimLeaseOutboxRelay(store, producer, {
      ...baseOptions,
      publishTimeoutMs: 20,
      leaseMs: 100,
    });

    await relay.flush();

    expect(store.markFailed).toHaveBeenCalledWith(
      'event-1',
      'worker-1',
      1,
      expect.any(Date),
      'Kafka publish timed out after 20ms',
    );
    expect(store.markPublished).not.toHaveBeenCalled();
  });

  it('propagates database ack errors instead of converting them into markFailed', async () => {
    const { store, relay } = fixture();
    vi.mocked(store.markPublished).mockRejectedValueOnce(
      new Error('db ack failed'),
    );

    await expect(relay.flush()).rejects.toThrow('db ack failed');
    expect(store.markFailed).not.toHaveBeenCalled();
  });

  it('rejects invalid configurations including leaseMs <= publishTimeoutMs', () => {
    const { store, producer } = fixture();
    expect(
      () =>
        new ClaimLeaseOutboxRelay(store, producer, {
          ...baseOptions,
          leaseMs: 1000,
          publishTimeoutMs: 1000,
        }),
    ).toThrow('Invalid claim-lease outbox relay configuration');
    expect(
      () =>
        new ClaimLeaseOutboxRelay(store, producer, {
          ...baseOptions,
          retryMaxMs: 50,
          retryBaseMs: 100,
        }),
    ).toThrow('Invalid claim-lease outbox relay configuration');
    expect(
      () =>
        new ClaimLeaseOutboxRelay(store, producer, {
          ...baseOptions,
          batchSize: 0,
        }),
    ).toThrow('Invalid claim-lease outbox relay configuration');
    expect(
      () =>
        new ClaimLeaseOutboxRelay(store, producer, {
          ...baseOptions,
          workerId: '   ',
        }),
    ).toThrow('Invalid claim-lease outbox relay configuration');
    expect(
      () =>
        new ClaimLeaseOutboxRelay(store, producer, {
          ...baseOptions,
          defaultTopic: '   ',
        }),
    ).toThrow('Invalid claim-lease outbox relay configuration');
  });
});
