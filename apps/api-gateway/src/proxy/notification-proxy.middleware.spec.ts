import { ConfigService } from '@nestjs/config';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { gatewayConfigSchema } from '../config/gateway-config.schema.js';
import { NotificationProxyMiddleware } from './notification-proxy.middleware.js';

vi.mock('http-proxy-middleware', () => ({
  createProxyMiddleware: vi.fn(() => {
    const proxy = vi.fn();
    proxy.upgrade = vi.fn();
    return proxy;
  }),
  fixRequestBody: vi.fn(),
}));

describe('Notification Gateway proxy boundary', () => {
  beforeEach(() => vi.clearAllMocks());

  it('disables automatic server.on("upgrade") on both proxies and omits HTTP keep-alive agent from wsProxy', () => {
    new NotificationProxyMiddleware(
      new ConfigService({
        NOTIFICATION_SERVICE_URL: 'https://notification.example.test',
      }),
    );

    const calls = vi.mocked(createProxyMiddleware).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[0]?.ws).toBe(false);
    expect(calls[0]?.[0]?.agent).toBeDefined();
    expect(calls[1]?.[0]?.ws).toBe(false);
    expect(calls[1]?.[0]?.agent).toBeUndefined();
    expect(calls[1]?.[0]?.timeout).toBeUndefined();
  });

  it.each([
    ['/api/v1/notifications', true, false],
    ['/api/v1/notifications/unread-count', true, false],
    ['/api/v1/notifications/123/read', true, false],
    ['/api/v1/notifications/admin/broadcasts', true, false],
    ['/api/v1/notifications/admin/broadcasts/123', true, false],
    ['/ws/notifications', true, true],
    ['/ws/notifications/?EIO=4&transport=polling', true, true],
    ['/ws/notifications/?EIO=4&transport=websocket', true, true],
    ['/api/v1/notifications-other', false, false],
    ['/ws/notifications-other', false, false],
    ['/api/v1/internal/notifications', false, false],
  ])(
    'matches complete notification segments %s -> http:%s ws:%s',
    (path, expectedHttp, expectedWs) => {
      new NotificationProxyMiddleware(
        new ConfigService({
          NOTIFICATION_SERVICE_URL: 'https://notification.example.test',
        }),
      );
      const httpFilter = vi.mocked(createProxyMiddleware).mock.calls[0]?.[0]
        ?.pathFilter;
      const wsFilter = vi.mocked(createProxyMiddleware).mock.calls[1]?.[0]
        ?.pathFilter;
      if (typeof httpFilter !== 'function' || typeof wsFilter !== 'function') {
        throw new Error('Expected HTTP and WebSocket path filters');
      }
      expect(httpFilter(path, new IncomingMessage(new Socket()))).toBe(
        expectedHttp,
      );
      expect(wsFilter(path, new IncomingMessage(new Socket()))).toBe(
        expectedWs,
      );
    },
  );

  it('forwards WebSocket upgrade only to wsProxy for /ws/notifications paths', () => {
    const middleware = new NotificationProxyMiddleware(
      new ConfigService({
        NOTIFICATION_SERVICE_URL: 'https://notification.example.test',
      }),
    );
    const httpProxy = vi.mocked(createProxyMiddleware).mock.results[0]?.value as {
      upgrade: ReturnType<typeof vi.fn>;
    };
    const wsProxy = vi.mocked(createProxyMiddleware).mock.results[1]?.value as {
      upgrade: ReturnType<typeof vi.fn>;
    };

    const wsRequest = new IncomingMessage(new Socket());
    wsRequest.url = '/ws/notifications/?EIO=4&transport=websocket';
    const socket = new Socket();
    const head = Buffer.alloc(0);

    middleware.upgrade(wsRequest, socket, head);

    expect(httpProxy.upgrade).not.toHaveBeenCalled();
    expect(wsProxy.upgrade).toHaveBeenCalledWith(wsRequest, socket, head);

    vi.clearAllMocks();
    const otherRequest = new IncomingMessage(new Socket());
    otherRequest.url = '/other';
    middleware.upgrade(otherRequest, socket, head);
    expect(wsProxy.upgrade).not.toHaveBeenCalled();
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
        AUDIT_SERVICE_URL: 'https://audit.example.test',
        NOTIFICATION_SERVICE_URL: 'https://notification.example.test',
      }).success,
    ).toBe(true);
  });
});
