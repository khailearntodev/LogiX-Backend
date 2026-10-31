import { randomUUID } from 'node:crypto';
import { ServiceId } from '@logix/common';
import type { ConfigService } from '@nestjs/config';
import { verifyInternalServiceToken } from '@logix/auth';
import { MasterDataClient } from './master-data.client.js';

describe('Master Data reference client', () => {
  const secret = 'a'.repeat(32);
  afterEach(() => vi.unstubAllGlobals());

  it('uses the forwarded user JWT for the profile read and signed D-14 link lock before assignment', async () => {
    const tenantId = randomUUID();
    const driverId = randomUUID();
    const userId = randomUUID();
    const version = 4;
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: driverId,
        tenantId,
        userId,
        status: 'ACTIVE',
        version,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        driverId,
        userId,
        version,
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const config = {
      getOrThrow: vi.fn((key: string) => ({
        MASTER_DATA_SERVICE_URL: 'http://master-data.test',
        INTERNAL_SERVICE_JWT_SECRET: secret,
      }[key])),
    } as unknown as ConfigService;
    const client = new MasterDataClient(config);

    await expect(client.lockDriver(
      tenantId,
      driverId,
      'Bearer trusted-user-token',
    )).resolves.toEqual({ driverId, userId, version });

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      new URL(`http://master-data.test/api/v1/drivers/${driverId}`),
      expect.objectContaining({
        headers: { authorization: 'Bearer trusted-user-token' },
      }),
    );
    const [url, options] = fetch.mock.calls[1] as [URL, RequestInit];
    expect(url).toEqual(new URL(`http://master-data.test/api/v1/internal/drivers/${driverId}/link-lock`));
    const token = (options.headers as Record<string, string>)['x-internal-service-token'];
    expect(verifyInternalServiceToken(token, {
      secret,
      audience: ServiceId.MASTER_DATA_SERVICE,
      allowedIssuers: [ServiceId.TRANSPORT_SERVICE],
    })).toEqual({
      service: ServiceId.TRANSPORT_SERVICE,
      audience: ServiceId.MASTER_DATA_SERVICE,
      tenantId,
    });
    expect(JSON.parse(options.body as string)).toEqual({
      version,
      expectedUserId: userId,
    });
  });

  it('does not accept a Master Data binding that differs from the profile read', async () => {
    const tenantId = randomUUID();
    const driverId = randomUUID();
    const userId = randomUUID();
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: driverId,
        tenantId,
        userId,
        status: 'ACTIVE',
        version: 3,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        driverId,
        userId: randomUUID(),
        version: 3,
      }), { status: 200 })));
    const client = new MasterDataClient({
      getOrThrow: vi.fn((key: string) => ({
        MASTER_DATA_SERVICE_URL: 'http://master-data.test',
        INTERNAL_SERVICE_JWT_SECRET: secret,
      }[key])),
    } as unknown as ConfigService);

    await expect(client.lockDriver(
      tenantId,
      driverId,
      'Bearer token',
    )).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });
});
