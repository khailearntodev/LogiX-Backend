import { ConfigService } from '@nestjs/config';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { MasterDataProxyMiddleware } from './master-data-proxy.middleware.js';

vi.mock('http-proxy-middleware', () => ({
  createProxyMiddleware: vi.fn(() => vi.fn()),
  fixRequestBody: vi.fn(),
}));
describe('Driver Gateway boundary', () => {
  beforeEach(() => vi.clearAllMocks());
  it.each([
    ['/api/v1/drivers', true],
    ['/api/v1/drivers/eligible-users', true],
    ['/api/v1/drivers-other', false],
    ['/api/v1/internal/driver-users', false],
  ])('matches complete public segments %s', (path, expected) => {
    new MasterDataProxyMiddleware(
      new ConfigService({
        MASTER_DATA_SERVICE_URL: 'https://master.example.test',
      }),
    );
    const filter = vi.mocked(createProxyMiddleware).mock.calls[0][0]
      ?.pathFilter;
    if (typeof filter !== 'function')
      throw new Error('Expected segment filter');
    expect(filter(path, new IncomingMessage(new Socket()))).toBe(expected);
  });
  it('fails closed without explicit target', () =>
    expect(() => new MasterDataProxyMiddleware(new ConfigService())).toThrow(
      'MASTER_DATA_SERVICE_URL',
    ));
});
