import { ConfigService } from '@nestjs/config';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { AuthProxyMiddleware } from './auth-proxy.middleware.js';
import { gatewayConfigSchema } from '../config/gateway-config.schema.js';

vi.mock('http-proxy-middleware', () => ({
  createProxyMiddleware: vi.fn(() => vi.fn()),
  fixRequestBody: vi.fn(),
}));

describe('Identity proxy boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['/api/v1/admin', true],
    ['/api/v1/admin/organizations', true],
    ['/api/v1/admin/users', true],
    ['/api/v1/admin/users/nested', true],
    ['/api/v1/administrator', false],
    ['/api/v1/admin-other', false],
    ['/api/v1/auth', true],
    ['/api/v1/auth/login', true],
    ['/api/v1/authentic', false],
    ['/api/v1/iam', true],
    ['/api/v1/iam/roles', true],
    ['/api/v1/iam-other', false],
  ])('matches complete Identity segments only: %s -> %s', (path, expected) => {
    new AuthProxyMiddleware(
      new ConfigService({
        IDENTITY_SERVICE_URL: 'http://identity.example.test',
      }),
    );
    const filter = vi.mocked(createProxyMiddleware).mock.calls[0][0]
      ?.pathFilter;
    expect(typeof filter).toBe('function');
    if (typeof filter !== 'function')
      throw new Error('Expected segment-based Identity proxy filter');
    expect(filter(path, new IncomingMessage(new Socket()))).toBe(expected);
  });

  it('fails closed without an explicit Identity target', () => {
    expect(() => new AuthProxyMiddleware(new ConfigService())).toThrow(
      'IDENTITY_SERVICE_URL',
    );
    expect(
      gatewayConfigSchema.safeParse({
        ORDER_SERVICE_URL: 'http://order.example.test',
        FULFILLMENT_SERVICE_URL: 'http://fulfillment.example.test',
      }).success,
    ).toBe(false);
  });
});
