import { ConfigService } from '@nestjs/config';
import { IdentityDriverClient } from './identity-driver.client.js';
import {
  INTERNAL_SERVICE_TOKEN_HEADER,
  verifyInternalServiceToken,
} from '@logix/auth';
import { randomBytes, randomUUID } from 'node:crypto';

describe('Driver Identity client', () => {
  const secret = randomBytes(32).toString('hex');
  const tenantId = randomUUID(),
    userId = randomUUID();
  let client: IdentityDriverClient;
  const user = {
    id: userId,
    displayName: 'Driver',
    email: 'driver@example.test',
    status: 'ACTIVE',
  };
  beforeEach(() => {
    client = new IdentityDriverClient(
      new ConfigService({
        IDENTITY_SERVICE_URL: 'https://identity.example.test',
        INTERNAL_SERVICE_JWT_SECRET: secret,
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());
  it('binds authenticated internal caller/audience/tenant', async () => {
    const mock = vi.fn().mockResolvedValue(new Response(JSON.stringify(user)));
    vi.stubGlobal('fetch', mock);
    expect(await client.eligible(tenantId, userId)).toEqual(user);
    expect(mock.mock.calls[0][0]).toBe(
      `https://identity.example.test/api/v1/internal/driver-users/${userId}/eligibility`,
    );
    const options = mock.mock.calls[0][1];
    expect(
      verifyInternalServiceToken(
        options.headers[INTERNAL_SERVICE_TOKEN_HEADER],
        {
          secret,
          audience: 'identity-service',
          allowedIssuers: ['master-data-service'],
        },
      ).tenantId,
    ).toBe(tenantId);
  });
  it.each([
    new Response('{}'),
    new Response('not json'),
    new Response('{}', { status: 500 }),
  ])(
    'fails explicitly on upstream invalid/unavailable data',
    async (response) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
      await expect(client.eligible(tenantId, userId)).rejects.toThrow();
    },
  );
  it('does not fabricate names when Identity cannot respond', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
    await expect(client.resolve(tenantId, [userId])).rejects.toThrow(
      'Dịch vụ danh tính',
    );
  });
  it('rejects missing/unrequested identities in a bulk response', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ items: [{ ...user, id: randomUUID() }] }),
          ),
        ),
    );
    await expect(client.resolve(tenantId, [userId])).rejects.toThrow(
      'không khớp',
    );
  });
});
