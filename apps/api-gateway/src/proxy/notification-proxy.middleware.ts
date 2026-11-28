import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createProxyMiddleware,
  fixRequestBody,
} from 'http-proxy-middleware';
import type { Request, Response, NextFunction } from 'express';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { DEFAULT_PROXY_TIMEOUT_MS, resolveProxyAgent } from './proxy-agent.js';

const NOTIFICATION_PREFIX = '/api/v1/notifications';
const NOTIFICATION_WS_PATH = '/ws/notifications';

@Injectable()
export class NotificationProxyMiddleware implements NestMiddleware {
  private readonly logger = new Logger(NotificationProxyMiddleware.name);
  private readonly httpProxy: ReturnType<
    typeof createProxyMiddleware<Request, Response>
  >;
  private readonly wsProxy: ReturnType<
    typeof createProxyMiddleware<Request, Response>
  >;

  constructor(config: ConfigService) {
    const target = config.getOrThrow<string>('NOTIFICATION_SERVICE_URL');

    // Keep ws: false on the HTTP middleware proxy so NestJS's separate
    // middleware instance never registers a duplicate server.on('upgrade')
    // listener alongside main.ts calling notificationProxy.upgrade.
    this.httpProxy = createProxyMiddleware<Request, Response>({
      target,
      agent: resolveProxyAgent(target),
      timeout: DEFAULT_PROXY_TIMEOUT_MS,
      proxyTimeout: DEFAULT_PROXY_TIMEOUT_MS,
      changeOrigin: true,
      ws: false,
      pathFilter: (path: string) => this.isNotificationPath(path),
      on: {
        proxyReq: (proxyReq, req) => {
          if (req.ip) proxyReq.setHeader('x-forwarded-for', req.ip);
          fixRequestBody(proxyReq, req);
        },
        error: (error, _req, res) => {
          this.logger.error(
            { message: error.message },
            'Notification proxy failed',
          );
          if ('status' in res && !res.headersSent) {
            res.status(502).json({
              statusCode: 502,
              error: 'Bad Gateway',
              message: 'Dịch vụ thông báo hiện không phản hồi. Vui lòng thử lại sau.',
            });
          }
        },
      },
    });

    // Dedicated upgrade proxy without HTTP keep-alive agent or 15s HTTP timeout,
    // manually invoked from main.ts server.on('upgrade').
    this.wsProxy = createProxyMiddleware<Request, Response>({
      target,
      changeOrigin: true,
      ws: false,
      pathFilter: (path: string) => this.isNotificationWsPath(path),
      on: {
        error: (error, _req, res) => {
          this.logger.error(
            { message: error.message },
            'Notification WebSocket proxy failed',
          );
          if ('destroy' in res && typeof res.destroy === 'function') {
            res.destroy();
          }
        },
      },
    });
  }

  use(req: Request, res: Response, next: NextFunction) {
    this.httpProxy(req, res, next);
  }

  upgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    if (!this.isNotificationWsPath(req.url ?? '')) {
      return;
    }

    const upgrade = this.wsProxy.upgrade as unknown as (
      request: IncomingMessage,
      clientSocket: Socket,
      headBuffer: Buffer,
    ) => void;
    upgrade(req, socket, head);
  }

  private isNotificationPath(path: string): boolean {
    const pathname = path.split('?')[0];
    return (
      pathname === NOTIFICATION_PREFIX ||
      pathname.startsWith(`${NOTIFICATION_PREFIX}/`) ||
      this.isNotificationWsPath(pathname)
    );
  }

  private isNotificationWsPath(path: string): boolean {
    const pathname = path.split('?')[0];
    return (
      pathname === NOTIFICATION_WS_PATH ||
      pathname.startsWith(`${NOTIFICATION_WS_PATH}/`)
    );
  }
}
