import { ConfigService } from '@nestjs/config';
import jwt from 'jsonwebtoken';
import type { Server, Socket } from 'socket.io';
import { NotificationsGateway } from './notifications.gateway.js';

const JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

function createToken(
  overrides: Record<string, unknown> = {},
  expiresIn: string | number = '15m',
): string {
  return jwt.sign(
    {
      sub: 'user-1',
      email: 'user@logix.test',
      tenantId: 'tenant-1',
      role: 'ADMIN',
      type: 'access',
      ...overrides,
    },
    JWT_SECRET,
    { algorithm: 'HS256', expiresIn },
  );
}

function createMockSocket(options?: {
  authToken?: unknown;
  authorization?: string;
}): Socket {
  return {
    data: {},
    handshake: {
      auth:
        options && 'authToken' in options
          ? { token: options.authToken }
          : {},
      headers: options?.authorization
        ? { authorization: options.authorization }
        : {},
    },
    join: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
  } as unknown as Socket;
}

describe('NotificationsGateway', () => {
  let gateway: NotificationsGateway;

  beforeEach(() => {
    gateway = new NotificationsGateway(
      new ConfigService({ JWT_SECRET }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('afterInit auth middleware', () => {
    function getMiddleware() {
      let registered:
        | ((client: Socket, next: (err?: Error) => void) => void)
        | undefined;
      const mockServer = {
        use: vi.fn((fn) => {
          registered = fn;
        }),
      } as unknown as Server;

      gateway.afterInit(mockServer);
      if (!registered) throw new Error('Expected middleware to be registered');
      return registered;
    }

    it('rejects missing token with UNAUTHORIZED', () => {
      const middleware = getMiddleware();
      const client = createMockSocket();
      const next = vi.fn();

      middleware(client, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(next.mock.calls[0]?.[0]).toBeInstanceOf(Error);
      expect((next.mock.calls[0]?.[0] as Error | undefined)?.message).toBe(
        'UNAUTHORIZED',
      );
      expect(client.data.user).toBeUndefined();
    });

    it('rejects invalid or expired token with UNAUTHORIZED', () => {
      const middleware = getMiddleware();

      const badClient = createMockSocket({ authToken: 'invalid-jwt' });
      const badNext = vi.fn();
      middleware(badClient, badNext);
      expect((badNext.mock.calls[0]?.[0] as Error | undefined)?.message).toBe(
        'UNAUTHORIZED',
      );

      const expiredToken = createToken({}, -10);
      const expiredClient = createMockSocket({ authToken: expiredToken });
      const expiredNext = vi.fn();
      middleware(expiredClient, expiredNext);
      expect(
        (expiredNext.mock.calls[0]?.[0] as Error | undefined)?.message,
      ).toBe('UNAUTHORIZED');
    });

    it('accepts valid HS256 token from handshake.auth.token and sets client.data.user', () => {
      const middleware = getMiddleware();
      const token = createToken({ sub: 'u-123', tenantId: 't-456' });
      const client = createMockSocket({ authToken: token });
      const next = vi.fn();

      middleware(client, next);

      expect(next).toHaveBeenCalledWith();
      expect(client.data.user).toMatchObject({
        id: 'u-123',
        tenantId: 't-456',
      });
    });

    it('accepts valid HS256 token from Authorization Bearer header', () => {
      const middleware = getMiddleware();
      const token = createToken({ sub: 'u-789', tenantId: 't-999' });
      const client = createMockSocket({ authorization: `Bearer ${token}` });
      const next = vi.fn();

      middleware(client, next);

      expect(next).toHaveBeenCalledWith();
      expect(client.data.user).toMatchObject({
        id: 'u-789',
        tenantId: 't-999',
      });
    });
  });

  describe('handleConnection', () => {
    it('reuses client.data.user populated by middleware and joins tenant-user room', () => {
      const client = createMockSocket();
      client.data.user = {
        id: 'u-1',
        tenantId: 't-1',
        email: 'user@logix.test',
        role: 'ADMIN',
      };

      gateway.handleConnection(client);

      expect(client.join).toHaveBeenCalledWith('tenant:t-1:user:u-1');
      expect(client.disconnect).not.toHaveBeenCalled();
    });

    it('disconnects if called directly without user or valid token', () => {
      const client = createMockSocket();

      gateway.handleConnection(client);

      expect(client.join).not.toHaveBeenCalled();
      expect(client.disconnect).toHaveBeenCalledWith(true);
    });
  });

  describe('emitters', () => {
    it('emits notification.created and notification.unread-count to tenant-user room', () => {
      const emit = vi.fn();
      const to = vi.fn(() => ({ emit }));
      (gateway as unknown as { server: Server }).server = {
        to,
      } as unknown as Server;

      gateway.emitNotification('t-1', 'u-1', { id: 'n-1', title: 'Hello' });
      expect(to).toHaveBeenCalledWith('tenant:t-1:user:u-1');
      expect(emit).toHaveBeenCalledWith('notification.created', {
        id: 'n-1',
        title: 'Hello',
      });

      gateway.emitUnreadCount('t-1', 'u-1', 5);
      expect(to).toHaveBeenCalledWith('tenant:t-1:user:u-1');
      expect(emit).toHaveBeenCalledWith('notification.unread-count', {
        count: 5,
      });
    });
  });
});
