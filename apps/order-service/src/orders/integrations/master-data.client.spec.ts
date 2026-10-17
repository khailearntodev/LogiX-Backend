import type { ConfigService } from '@nestjs/config';
import { ORDER_ERROR_REASON } from '../domain/order-errors.js';
import { MasterDataClient } from './master-data.client.js';

const ctx = {
  authorization: 'Bearer token',
  correlationId: '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a',
};

const config = {
  getOrThrow: vi.fn().mockReturnValue('http://master-data.internal:3004/'),
} as unknown as ConfigService;

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('MasterDataClient', () => {
  const fetchMock = vi.fn<typeof fetch>();
  let client: MasterDataClient;

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    client = new MasterDataClient(config);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('forwards credentials and correlation id to the versioned API', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { id: 'w1' }));

    await expect(client.getWarehouse('w1', ctx)).resolves.toEqual({ id: 'w1' });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('http://master-data.internal:3004/api/v1/warehouses/w1');
    expect(init?.headers).toMatchObject({
      authorization: ctx.authorization,
      'x-correlation-id': ctx.correlationId,
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('maps 404 to null', async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { message: 'not found' }));

    await expect(client.getProduct('p1', ctx)).resolves.toBeNull();
  });

  it.each([500, 503])('maps %s to 503 UPSTREAM_UNAVAILABLE', async (status) => {
    fetchMock.mockResolvedValue(jsonResponse(status, {}));

    await expect(client.getCustomer('c1', ctx)).rejects.toMatchObject({
      httpStatus: 503,
      reason: ORDER_ERROR_REASON.UPSTREAM_UNAVAILABLE,
    });
  });

  it('maps timeouts and network failures to 503 UPSTREAM_UNAVAILABLE', async () => {
    fetchMock.mockRejectedValue(
      new DOMException('The operation timed out', 'TimeoutError'),
    );

    await expect(client.getCustomer('c1', ctx)).rejects.toMatchObject({
      httpStatus: 503,
      reason: ORDER_ERROR_REASON.UPSTREAM_UNAVAILABLE,
    });
  });

  it.each([401, 403, 400])(
    'maps %s to 502 UPSTREAM_REJECTED',
    async (status) => {
      fetchMock.mockResolvedValue(jsonResponse(status, {}));

      await expect(
        client.listCustomerAddresses('c1', ctx),
      ).rejects.toMatchObject({
        httpStatus: 502,
        reason: ORDER_ERROR_REASON.UPSTREAM_REJECTED,
      });
    },
  );

  it('maps malformed bodies to 503 UPSTREAM_UNAVAILABLE', async () => {
    fetchMock.mockResolvedValue(new Response('not-json', { status: 200 }));

    await expect(client.getProduct('p1', ctx)).rejects.toMatchObject({
      httpStatus: 503,
    });
  });
});
