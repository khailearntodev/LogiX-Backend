import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseEventEnvelope } from '../src/kafka-event-consumer.js';
import { startIsolatedKafka } from './support/isolated-kafka.js';

describe('isolated Kafka foundation', () => {
  it('creates an owned topic/group and roundtrips an event with identity intact', async () => {
    const fixture = await startIsolatedKafka();
    const admin = fixture.kafka.admin();
    const producer = fixture.kafka.producer({ allowAutoTopicCreation: false });
    const consumer = fixture.kafka.consumer({
      groupId: fixture.groupId,
      retry: { retries: 10, initialRetryTime: 300, maxRetryTime: 2_000 },
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await admin.connect();
      await admin.createTopics({
        waitForLeaders: true,
        topics: [{ topic: fixture.topic, numPartitions: 1, replicationFactor: 1 }],
      });
      const tripId = randomUUID();
      const event = {
        eventId: randomUUID(), eventType: 'TripPlanned', eventVersion: 1,
        tenantId: randomUUID(), actorId: randomUUID(), correlationId: randomUUID(),
        causationId: randomUUID(), occurredAt: new Date().toISOString(),
        aggregateType: 'DeliveryTrip', aggregateId: tripId, aggregateVersion: 1,
        producer: 'transport-service',
        payload: {
          tripId, warehouseId: randomUUID(), vehicleId: randomUUID(),
          driverId: randomUUID(), shipmentIds: [randomUUID()],
        },
      };
      await producer.connect();
      await consumer.connect();
      await consumer.subscribe({ topic: fixture.topic, fromBeginning: true });
      const received = new Promise<unknown>((resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Owned Kafka topic roundtrip timed out')), 30_000);
        consumer.on(consumer.events.CRASH, ({ payload }) => reject(payload.error));
        void consumer.run({
          eachMessage: async ({ topic, message }) => {
            try {
              expect(topic).toBe(fixture.topic);
              expect(message.key?.toString()).toBe(event.aggregateId);
              if (!message.value) throw new Error('Kafka test message has no value');
              resolve(parseEventEnvelope(message.value.toString()));
            } catch (error) {
              reject(error);
            }
          },
        }).catch(reject);
      });
      const [delivered] = await Promise.all([
        received,
        producer.send({
          topic: fixture.topic,
          messages: [{ key: event.aggregateId, value: JSON.stringify(event) }],
        }),
      ]);
      expect(delivered).toEqual(event);
      expect(await admin.listTopics()).toContain(fixture.topic);
    } finally {
      if (timeout) clearTimeout(timeout);
      const cleanup = await Promise.allSettled([
        consumer.disconnect(), producer.disconnect(), admin.disconnect(),
      ]);
      await fixture.dispose();
      expect(cleanup.filter((result) => result.status === 'rejected')).toEqual([]);
    }
  }, 150_000);
});
