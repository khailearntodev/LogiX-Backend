import { describe, expect, it } from 'vitest';
import { auditConfigSchema } from './audit-config.schema.js';

const validConfig = {
  NODE_ENV: 'development',
  PORT: '3008',
  SERVICE_NAME: 'audit-service',
  DATABASE_URL: 'postgresql://user:pass@localhost:5433/logix_audit?schema=audit',
  JWT_SECRET: 'test-jwt-secret-with-enough-length',
  KAFKA_BROKERS: '127.0.0.1:9092',
  KAFKA_CLIENT_ID: 'audit-service',
  KAFKA_GROUP_ID: 'logix.audit.consumer.v1',
  KAFKA_IDENTITY_TOPIC: 'logix.identity.events.v1',
  KAFKA_INVENTORY_TOPIC: 'logix.inventory.events.v1',
  KAFKA_ORDER_TOPIC: 'logix.order.events.v1',
  KAFKA_FULFILLMENT_TOPIC: 'logix.fulfillment.events.v1',
  KAFKA_TRANSPORT_TOPIC: 'transport.events',
  KAFKA_AGENT_TOPIC: 'logix.agent.events.v1',
};

describe('auditConfigSchema', () => {
  it('accepts a complete configuration', () => {
    const parsed = auditConfigSchema.parse(validConfig);
    expect(parsed.KAFKA_AGENT_TOPIC).toBe('logix.agent.events.v1');
    expect(parsed.KAFKA_IDENTITY_TOPIC).toBe('logix.identity.events.v1');
  });

  it.each([
    'JWT_SECRET',
    'KAFKA_BROKERS',
    'KAFKA_IDENTITY_TOPIC',
    'KAFKA_INVENTORY_TOPIC',
    'KAFKA_ORDER_TOPIC',
    'KAFKA_FULFILLMENT_TOPIC',
    'KAFKA_TRANSPORT_TOPIC',
    'KAFKA_AGENT_TOPIC',
  ])('fails fast when required %s is missing', (key) => {
    const copy: Record<string, unknown> = { ...validConfig };
    delete copy[key];
    expect(() => auditConfigSchema.parse(copy)).toThrow();
  });
});
