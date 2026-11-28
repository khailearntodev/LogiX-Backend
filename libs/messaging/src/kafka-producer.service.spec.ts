import { ServiceId } from '@logix/common';
import type { Kafka } from 'kafkajs';
import { describe, expect, it, vi } from 'vitest';
import type { CommandEventEnvelope } from './event-envelope.js';
import { KafkaProducerService } from './kafka-producer.service.js';

function createProducerFixture() {
  const send = vi.fn().mockResolvedValue([]);
  const kafka = {
    producer: () => ({
      connect: vi.fn(),
      disconnect: vi.fn(),
      send,
    }),
  } as unknown as Kafka;

  return {
    send,
    service: new KafkaProducerService(kafka),
  };
}

function makeEnvelope(
  tenantId: string | null,
): CommandEventEnvelope<{ messageId: string }> {
  return {
    eventId: 'event-1',
    eventType: 'TransactionalEmailRequested',
    eventVersion: 1,
    occurredAt: '2026-11-26T10:00:00.000Z',
    producer: ServiceId.IDENTITY_SERVICE,
    tenantId,
    actorId: null,
    correlationId: 'corr-1',
    causationId: 'corr-1',
    aggregateType: 'ContactLead',
    aggregateId: 'lead-1',
    aggregateVersion: 1,
    payload: { messageId: 'msg-1' },
  };
}

describe('KafkaProducerService', () => {
  it('sets tenant-id header when tenantId is present', async () => {
    const { send, service } = createProducerFixture();
    await service.publishRaw(
      'notification.email.requested.v1',
      makeEnvelope('tenant-1'),
    );

    expect(send).toHaveBeenCalledWith({
      topic: 'notification.email.requested.v1',
      timeout: 3000,
      messages: [
        expect.objectContaining({
          key: 'lead-1',
          headers: {
            'event-type': 'TransactionalEmailRequested',
            'event-version': '1',
            'correlation-id': 'corr-1',
            'tenant-id': 'tenant-1',
          },
        }),
      ],
    });
  });

  it('omits tenant-id header when tenantId is null', async () => {
    const { send, service } = createProducerFixture();
    await service.publishRaw(
      'notification.email.requested.v1',
      makeEnvelope(null),
    );

    const record = send.mock.calls[0][0];
    expect(record.messages[0].headers).toEqual({
      'event-type': 'TransactionalEmailRequested',
      'event-version': '1',
      'correlation-id': 'corr-1',
    });
    expect('tenant-id' in record.messages[0].headers).toBe(false);
  });
});
