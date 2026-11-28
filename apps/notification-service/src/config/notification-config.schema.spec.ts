import { notificationConfigSchema } from './notification-config.schema.js';

const validConfig = {
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/notification',
  KAFKA_BROKERS: 'localhost:9092',
  KAFKA_CLIENT_ID: 'notification-service',
  KAFKA_GROUP_ID: 'logix-notification-service',
  KAFKA_ORDER_TOPIC: 'logix.order.events.v1',
  KAFKA_TRANSPORT_TOPIC: 'logix.transport.events.v1',
  JWT_SECRET: 'a'.repeat(32),
  INTERNAL_SERVICE_JWT_SECRET: 'b'.repeat(32),
  IDENTITY_SERVICE_URL: 'http://identity.example.test',
  IDENTITY_REQUEST_TIMEOUT_MS: 5000,
};

describe('notificationConfigSchema', () => {
  it('accepts the required notification runtime configuration and applies delivery worker defaults', () => {
    const parsed = notificationConfigSchema.safeParse(validConfig);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toMatchObject({
        DELIVERY_WORKER_ENABLED: true,
        DELIVERY_POLL_INTERVAL_MS: 500,
        DELIVERY_BATCH_SIZE: 50,
        DELIVERY_CONCURRENCY: 10,
        DELIVERY_LEASE_MS: 30000,
        DELIVERY_MAX_ATTEMPTS: 5,
        DELIVERY_RETRY_BASE_MS: 1000,
        DELIVERY_RETRY_MAX_MS: 60000,
        DELIVERY_RECLAIM_INTERVAL_MS: 15000,
        DELIVERY_TX_TIMEOUT_MS: 5000,
        KAFKA_NOTIFICATION_BROADCAST_TOPIC: 'notification.broadcast.requested.v1',
        OUTBOX_RELAY_ENABLED: true,
        OUTBOX_INTERVAL_MS: 500,
        OUTBOX_BATCH_SIZE: 50,
        OUTBOX_LEASE_MS: 15000,
        OUTBOX_PUBLISH_TIMEOUT_MS: 5000,
        OUTBOX_RETRY_BASE_MS: 1000,
        OUTBOX_RETRY_MAX_MS: 60000,
        OUTBOX_TX_TIMEOUT_MS: 5000,
        MAX_BROADCAST_RECIPIENTS: 5000,
        BROADCAST_FANOUT_BATCH_SIZE: 500,
      });
    }
  });

  it('rejects a short JWT secret', () => {
    expect(
      notificationConfigSchema.safeParse({ ...validConfig, JWT_SECRET: 'short' })
        .success,
    ).toBe(false);
  });

  it('parses string boolean DELIVERY_WORKER_ENABLED=false and rejects non-positive intervals', () => {
    const disabled = notificationConfigSchema.safeParse({
      ...validConfig,
      DELIVERY_WORKER_ENABLED: 'false',
    });
    expect(disabled.success).toBe(true);
    if (disabled.success) {
      expect(disabled.data.DELIVERY_WORKER_ENABLED).toBe(false);
    }

    const invalidConcurrency = notificationConfigSchema.safeParse({
      ...validConfig,
      DELIVERY_CONCURRENCY: 0,
    });
    expect(invalidConcurrency.success).toBe(false);
  });
});
