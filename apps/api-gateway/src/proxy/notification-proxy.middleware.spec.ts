import { ConfigService } from '@nestjs/config';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { gatewayConfigSchema } from '../config/gateway-config.schema.js';
import { NotificationProxyMiddleware } from './notification-proxy.middleware.js';

vi.mock('http-proxy-middleware', () => ({
  createProxyMiddleware: vi.fn(() => vi.fn()),
  fixRequestBody: vi.fn(),
}));

describe('Notification Gateway proxy boundary', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['/api/v1/notifications', true],
    ['/api/v1/notifications/unread-count', true],
    ['/api/v1/notifications/123/read', true],
    ['/api/v1/notifications-other', false],
    ['/api/v1/internal/notifications', false],
  ])('matches complete notification segments %s -> %s', (path, expected) => {
    new NotificationProxyMiddleware(
      new ConfigService({
        NOTIFICATION_SERVICE_URL: 'https://notification.example.test',
      }),
    );
    const filter = vi.mocked(createProxyMiddleware).mock.calls[0][0]
      ?.pathFilter;
    if (typeof filter !== 'function')
      throw new Error('Expected notification path filter');
    expect(filter(path, new IncomingMessage(new Socket()))).toBe(expected);
  });

  it('requires the notification service target', () => {
    expect(
      () => new NotificationProxyMiddleware(new ConfigService()),
    ).toThrow('NOTIFICATION_SERVICE_URL');
  });

  it('requires the notification target in gateway configuration', () => {
    expect(
      gatewayConfigSchema.safeParse({
        MASTER_DATA_SERVICE_URL: 'https://master.example.test',
        IDENTITY_SERVICE_URL: 'https://identity.example.test',
        ORDER_SERVICE_URL: 'https://order.example.test',
        FULFILLMENT_SERVICE_URL: 'https://fulfillment.example.test',
        TRANSPORT_SERVICE_URL: 'https://transport.example.test',
      }).success,
    ).toBe(false);

    expect(
      gatewayConfigSchema.safeParse({
        MASTER_DATA_SERVICE_URL: 'https://master.example.test',
        IDENTITY_SERVICE_URL: 'https://identity.example.test',
        ORDER_SERVICE_URL: 'https://order.example.test',
        FULFILLMENT_SERVICE_URL: 'https://fulfillment.example.test',
        TRANSPORT_SERVICE_URL: 'https://transport.example.test',
        NOTIFICATION_SERVICE_URL: 'https://notification.example.test',
      }).success,
    ).toBe(true);
  });
});
