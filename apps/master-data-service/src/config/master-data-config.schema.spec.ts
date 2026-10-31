import { masterDataConfigSchema } from './master-data-config.schema.js';
import { randomBytes } from 'node:crypto';

describe('Driver lookup configuration', () => {
  const valid = {
    DATABASE_URL: 'postgresql://test:test@db.example.test/test',
    JWT_SECRET: randomBytes(32).toString('hex'),
    INTERNAL_SERVICE_JWT_SECRET: randomBytes(32).toString('hex'),
    IDENTITY_SERVICE_URL: 'https://identity.example.test',
    TRANSPORT_SERVICE_URL: 'https://transport.example.test',
  };
  it('accepts explicit service configuration', () => {
    expect(masterDataConfigSchema.safeParse(valid).success).toBe(true);
  });
  it.each([
    'JWT_SECRET',
    'INTERNAL_SERVICE_JWT_SECRET',
    'IDENTITY_SERVICE_URL',
    'TRANSPORT_SERVICE_URL',
  ])('fails closed without %s', (key) => {
    const input: Record<string, unknown> = { ...valid };
    delete input[key];
    expect(masterDataConfigSchema.safeParse(input).success).toBe(false);
  });
});
