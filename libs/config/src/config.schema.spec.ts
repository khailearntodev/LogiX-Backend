import { describe, expect, it } from 'vitest';
import {
  baseConfigSchema,
  databaseConfigSchema,
  kafkaConfigSchema,
} from './config.schema.js';

describe('service configuration validation', () => {
  it('coerces an explicit port and preserves the service identity', () => {
    expect(baseConfigSchema.parse({
      NODE_ENV: 'test',
      PORT: '4123',
      SERVICE_NAME: 'qa-config',
    })).toEqual({ NODE_ENV: 'test', PORT: 4123, SERVICE_NAME: 'qa-config' });
  });

  it.each([undefined, ''])('rejects missing or empty service identity: %s', (name) => {
    const result = baseConfigSchema.safeParse({ SERVICE_NAME: name });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === 'SERVICE_NAME')).toBe(true);
    }
  });

  it.each(['0', '-1', '1.5', 'not-a-number'])('rejects invalid port %s', (port) => {
    expect(baseConfigSchema.safeParse({ SERVICE_NAME: 'qa-config', PORT: port }).success)
      .toBe(false);
  });

  it('parses and trims a configured Kafka broker list', () => {
    expect(kafkaConfigSchema.parse({
      KAFKA_BROKERS: 'qa-broker:9092, qa-broker-two:9093',
      KAFKA_CLIENT_ID: 'qa-config',
    }).KAFKA_BROKERS).toEqual(['qa-broker:9092', 'qa-broker-two:9093']);
  });

  it.each(['', 'qa-broker', 'qa-broker:abc', 'qa-broker:9092,'])(
    'rejects malformed Kafka broker list %s',
    (brokers) => {
      const result = kafkaConfigSchema.safeParse({
        KAFKA_BROKERS: brokers,
        KAFKA_CLIENT_ID: 'qa-config',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((issue) => issue.path[0] === 'KAFKA_BROKERS')).toBe(true);
      }
    },
  );

  it.each([undefined, 'not-a-url', 'https://qa-database'])(
    'rejects missing or non-PostgreSQL database URL %s',
    (url) => {
      expect(databaseConfigSchema.safeParse({ DATABASE_URL: url }).success).toBe(false);
    },
  );

  it('applies safe DB pool and Kafka producer budget defaults while rejecting invalid overrides', () => {
    const db = databaseConfigSchema.parse({
      DATABASE_URL: 'postgresql://user:pass@localhost:5433/logix',
    });
    expect(db.DB_POOL_MAX).toBe(20);
    expect(db.DB_POOL_IDLE_TIMEOUT_MS).toBe(30000);
    expect(db.DB_POOL_CONNECTION_TIMEOUT_MS).toBe(10000);
    expect(
      databaseConfigSchema.safeParse({
        DATABASE_URL: 'postgresql://user:pass@localhost:5433/logix',
        DB_POOL_MAX: '0',
      }).success,
    ).toBe(false);

    const kafka = kafkaConfigSchema.parse({
      KAFKA_BROKERS: 'localhost:9092',
      KAFKA_CLIENT_ID: 'qa-config',
    });
    expect(kafka.KAFKA_CONNECTION_TIMEOUT_MS).toBe(3000);
    expect(kafka.KAFKA_REQUEST_TIMEOUT_MS).toBe(25000);
    expect(kafka.KAFKA_PRODUCER_MAX_RETRIES).toBe(1);
    expect(kafka.KAFKA_PRODUCER_SEND_TIMEOUT_MS).toBe(3000);
    expect(
      kafkaConfigSchema.safeParse({
        KAFKA_BROKERS: 'localhost:9092',
        KAFKA_CLIENT_ID: 'qa-config',
        KAFKA_PRODUCER_SEND_TIMEOUT_MS: '100',
      }).success,
    ).toBe(false);
  });
});
