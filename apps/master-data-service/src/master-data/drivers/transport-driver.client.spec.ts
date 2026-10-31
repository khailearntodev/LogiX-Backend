import { randomBytes, randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import {
  INTERNAL_SERVICE_TOKEN_HEADER,
  verifyInternalServiceToken,
} from '@logix/auth';
import { TransportDriverClient } from './transport-driver.client.js';

describe('Transport Driver history client', () => {
  const secret = randomBytes(32).toString('hex');
  const tenantId = randomUUID(),
    driverId = randomUUID();
  const client = new TransportDriverClient(
    new ConfigService({
      TRANSPORT_SERVICE_URL: 'https://transport.example.test/',
      INTERNAL_SERVICE_JWT_SECRET: secret,
    }),
  );
  afterEach(() => vi.unstubAllGlobals());

  it.each([true, false])(
    'accepts explicit used=%s only from bound tenant/driver response',
    async (used) => {
      const mock = vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ tenantId, driverId, used })),
        );
      vi.stubGlobal('fetch', mock);
      expect(await client.used(tenantId, driverId)).toBe(used);
      expect(mock.mock.calls[0][0]).toBe(
        `https://transport.example.test/api/v1/internal/drivers/${driverId}/usage`,
      );
      const options = mock.mock.calls[0][1];
      expect(
        verifyInternalServiceToken(
          options.headers[INTERNAL_SERVICE_TOKEN_HEADER],
          {
            secret,
            audience: 'transport-service',
            allowedIssuers: ['master-data-service'],
          },
        ).tenantId,
      ).toBe(tenantId);
      expect(options.signal).toBeInstanceOf(AbortSignal);
    },
  );
  it.each([
    {},
    { tenantId, driverId, used: 'false' },
    { tenantId: randomUUID(), driverId, used: false },
    { tenantId, driverId: randomUUID(), used: false },
  ])(
    'rejects malformed/mismatched usage rather than assuming unused: %j',
    async (body) => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(new Response(JSON.stringify(body))),
      );
      await expect(client.used(tenantId, driverId)).rejects.toThrow('không');
    },
  );
  it.each([401, 404, 500, 503])(
    'fails closed for upstream status %s',
    async (status) => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(new Response('{}', { status })),
      );
      await expect(client.used(tenantId, driverId)).rejects.toThrow(
        'Không thể xác minh',
      );
    },
  );
  it('fails closed on network outage and invalid JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
    await expect(client.used(tenantId, driverId)).rejects.toThrow(
      'Không thể xác minh',
    );
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not-json')));
    await expect(client.used(tenantId, driverId)).rejects.toThrow(
      'không hợp lệ',
    );
  });
});
