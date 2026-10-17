import { ConfigService } from '@nestjs/config';
import { verifyInternalServiceToken } from '@logix/auth';
import { InventoryClient } from './inventory.client.js';
import {
  commandContext,
  ORDER_ID,
  TENANT_ID,
  PRODUCT_A_ID,
  WAREHOUSE_ID,
} from '../../../test/fixtures/order.fixtures.js';

const SECRET = 'test-only-internal-secret-with-32-characters';
const request = {
  orderId: ORDER_ID,
  orderVersion: 1,
  warehouseId: WAREHOUSE_ID,
  lines: [
    {
      orderLineId: '00000000-0000-4000-8000-000000000099',
      productId: PRODUCT_A_ID,
      quantity: '10.000',
    },
  ],
};

describe('InventoryClient', () => {
  afterEach(() => vi.unstubAllGlobals());

  const client = () =>
    new InventoryClient(
      new ConfigService({
        INVENTORY_SERVICE_URL: 'http://inventory.test',
        INTERNAL_SERVICE_JWT_SECRET: SECRET,
      }),
    );

  it('forwards tenant/correlation and derives a stable reservation key without forwarding a user token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          outcome: 'RESERVED',
          reservationGroupId: '00000000-0000-4000-8000-000000000098',
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    await client().reserve(request, commandContext);
    const options = fetchMock.mock.calls[0][1];
    expect(options.headers['idempotency-key']).toBe(`order:${ORDER_ID}:v1`);
    expect(options.headers['x-correlation-id']).toBe(
      commandContext.correlationId,
    );
    expect(options.headers.authorization).toBeUndefined();
    expect(
      verifyInternalServiceToken(options.headers['x-internal-service-token'], {
        secret: SECRET,
        audience: 'inventory-service',
        allowedIssuers: ['order-service'],
      }).tenantId,
    ).toBe(TENANT_ID);
  });

  it.each([401, 403, 409])(
    'maps an upstream %s rejection to 502',
    async (status) => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(new Response('{}', { status })),
      );
      await expect(
        client().reserve(request, commandContext),
      ).rejects.toMatchObject({ httpStatus: 502 });
    },
  );

  it.each([500, 503])(
    'maps upstream %s to 503, not insufficient stock',
    async (status) => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(new Response('{}', { status })),
      );
      await expect(
        client().reserve(request, commandContext),
      ).rejects.toMatchObject({ httpStatus: 503 });
    },
  );

  it.each([
    '{}',
    '{"outcome":"INSUFFICIENT","shortages":[]}',
    '{"outcome":"RESERVED","reservationGroupId":"invalid"}',
    'not-json',
  ])('rejects malformed success response %s', async (body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)));
    await expect(
      client().reserve(request, commandContext),
    ).rejects.toMatchObject({ httpStatus: 503 });
  });

  it('maps a connection failure to 503', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new TypeError('connection refused')),
    );
    await expect(
      client().reserve(request, commandContext),
    ).rejects.toMatchObject({ httpStatus: 503 });
  });
});
