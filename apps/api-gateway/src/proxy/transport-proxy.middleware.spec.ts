import { ConfigService } from '@nestjs/config';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { gatewayConfigSchema } from '../config/gateway-config.schema.js';
import { TransportProxyMiddleware } from './transport-proxy.middleware.js';

vi.mock('http-proxy-middleware', () => ({
  createProxyMiddleware: vi.fn(() => vi.fn()),
  fixRequestBody: vi.fn(),
}));

describe('Trip Gateway boundary', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['/api/v1/trips', true],
    ['/api/v1/trips/eligible-shipments', true],
    ['/api/v1/trips/123/cancel', true],
    ['/api/v1/driver/trips', true],
    ['/api/v1/driver/trips/123/stops/456/deliver', true],
    ['/api/v1/driver/trips-other', false],
    ['/api/v1/trips-other', false],
    ['/api/v1/internal/drivers/123/usage', false],
    ['/api/v1/internal/shipments/claim', false],
  ])('matches only complete public trip segments %s', (path, expected) => {
    new TransportProxyMiddleware(
      new ConfigService({
        TRANSPORT_SERVICE_URL: 'https://transport.example.test',
      }),
    );
    const filter = vi.mocked(createProxyMiddleware).mock.calls[0][0]
      ?.pathFilter;
    if (typeof filter !== 'function')
      throw new Error('Expected segment filter');
    expect(filter(path, new IncomingMessage(new Socket()))).toBe(expected);
  });

  it('requires an explicit target', () => {
    expect(() => new TransportProxyMiddleware(new ConfigService())).toThrow(
      'TRANSPORT_SERVICE_URL',
    );
  });

  it('rejects missing or malformed Transport configuration', () => {
    const targets = {
      MASTER_DATA_SERVICE_URL: 'https://master.example.test',
      IDENTITY_SERVICE_URL: 'https://identity.example.test',
      ORDER_SERVICE_URL: 'https://order.example.test',
      FULFILLMENT_SERVICE_URL: 'https://fulfillment.example.test',
    };
    expect(gatewayConfigSchema.safeParse(targets).success).toBe(false);
    expect(
      gatewayConfigSchema.safeParse({
        ...targets,
        TRANSPORT_SERVICE_URL: 'not-a-url',
      }).success,
    ).toBe(false);
    expect(
      gatewayConfigSchema.safeParse({
        ...targets,
        TRANSPORT_SERVICE_URL: 'https://transport.example.test',
      }).success,
    ).toBe(true);
  });
});
