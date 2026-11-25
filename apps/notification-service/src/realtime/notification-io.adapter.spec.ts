import type { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import {
  NotificationIoAdapter,
  parseWsCorsOrigins,
} from './notification-io.adapter.js';

describe('parseWsCorsOrigins', () => {
  it('returns false when unset or blank', () => {
    expect(parseWsCorsOrigins(undefined)).toBe(false);
    expect(parseWsCorsOrigins('')).toBe(false);
    expect(parseWsCorsOrigins(' ,  , ')).toBe(false);
  });

  it('parses single and comma-separated trimmed origins', () => {
    expect(parseWsCorsOrigins('http://localhost:3009')).toEqual([
      'http://localhost:3009',
    ]);
    expect(
      parseWsCorsOrigins(' http://localhost:3009 , https://app.logix.test '),
    ).toEqual(['http://localhost:3009', 'https://app.logix.test']);
  });
});

describe('NotificationIoAdapter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes parsed CORS origins and credentials to Socket.IO server', () => {
    const spy = vi
      .spyOn(IoAdapter.prototype, 'createIOServer')
      .mockReturnValue({} as never);
    const app = {} as INestApplicationContext;
    const adapter = new NotificationIoAdapter(app, ['http://localhost:3009']);

    adapter.createIOServer(3007, { path: '/ws/notifications' } as never);

    expect(spy).toHaveBeenCalledWith(3007, {
      path: '/ws/notifications',
      cors: { origin: ['http://localhost:3009'], credentials: true },
    });
  });

  it('disables cross-origin access when WS_CORS_ORIGINS is not configured', () => {
    const spy = vi
      .spyOn(IoAdapter.prototype, 'createIOServer')
      .mockReturnValue({} as never);
    const app = {} as INestApplicationContext;
    const adapter = new NotificationIoAdapter(app, false);

    adapter.createIOServer(3007);

    expect(spy).toHaveBeenCalledWith(3007, {
      cors: { origin: false },
    });
  });
});
