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
  it('accepts the required notification runtime configuration', () => {
    expect(notificationConfigSchema.safeParse(validConfig).success).toBe(true);
  });

  it('rejects a short JWT secret', () => {
    expect(
      notificationConfigSchema.safeParse({ ...validConfig, JWT_SECRET: 'short' })
        .success,
    ).toBe(false);
  });
});
