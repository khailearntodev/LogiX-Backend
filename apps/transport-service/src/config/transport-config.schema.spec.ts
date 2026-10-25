import { randomBytes } from 'node:crypto';
import { transportConfigSchema } from './transport-config.schema.js';

describe('Transport internal usage configuration', () => {
  const database = { DATABASE_URL: 'postgresql://db.example.test/test' };
  it('requires explicit valid internal signing secret', () => {
    expect(transportConfigSchema.safeParse(database).success).toBe(false);
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
});
