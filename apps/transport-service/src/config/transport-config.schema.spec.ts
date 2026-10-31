import { randomBytes } from 'node:crypto';
import { transportConfigSchema } from './transport-config.schema.js';

describe('Transport internal usage configuration', () => {
  const database = {
    DATABASE_URL: 'postgresql://db.example.test/test',
    JWT_SECRET: randomBytes(32).toString('hex'),
    INTERNAL_SERVICE_JWT_SECRET: randomBytes(32).toString('hex'),
    TRIP_CANCEL_PREVIEW_SECRET: randomBytes(32).toString('hex'),
    MASTER_DATA_SERVICE_URL: 'http://localhost:3001',
    FULFILLMENT_SERVICE_URL: 'http://localhost:3004',
    ROUTE_OPTIMIZER_SERVICE_URL: 'http://optimizer.example.test',
    ROUTE_OPTIMIZER_TIMEOUT_MS: 30000,
    KAFKA_BROKERS: 'localhost:9092',
    KAFKA_CLIENT_ID: 'transport-service',
    KAFKA_GROUP_ID: 'transport-service',
    KAFKA_FULFILLMENT_TOPIC: 'fulfillment.events',
    KAFKA_TRANSPORT_TOPIC: 'transport.events',
    OUTBOX_INTERVAL_MS: 1000,
    OUTBOX_BATCH_SIZE: 10,
    OUTBOX_RETRY_BASE_MS: 1000,
    OUTBOX_RETRY_MAX_MS: 10000,
    OUTBOX_TRANSACTION_TIMEOUT_MS: 30000,
  };
  it('requires explicit valid internal signing secret', () => {
    expect(
      transportConfigSchema.safeParse({
        ...database,
        INTERNAL_SERVICE_JWT_SECRET: undefined,
      }).success,
    ).toBe(false);
    expect(
      transportConfigSchema.safeParse({
        ...database,
        INTERNAL_SERVICE_JWT_SECRET: 'short',
      }).success,
    ).toBe(false);
    expect(
      transportConfigSchema.safeParse({
        ...database,
        INTERNAL_SERVICE_JWT_SECRET: randomBytes(32).toString('hex'),
      }).success,
    ).toBe(true);
  });

  it('requires a dedicated cancellation-preview secret', () => {
    expect(
      transportConfigSchema.safeParse({
        ...database,
        TRIP_CANCEL_PREVIEW_SECRET: '',
      }).success,
    ).toBe(false);
    expect(transportConfigSchema.safeParse(database).success).toBe(true);
  });
});
