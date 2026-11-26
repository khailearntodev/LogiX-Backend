import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createProxyMiddleware,
  fixRequestBody,
} from 'http-proxy-middleware';
import type { Request, Response, NextFunction } from 'express';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';

const NOTIFICATION_PREFIX = '/api/v1/notifications';
const NOTIFICATION_WS_PATH = '/ws/notifications';

@Injectable()
export class NotificationProxyMiddleware implements NestMiddleware {
  private readonly logger = new Logger(NotificationProxyMiddleware.name);
  private readonly proxy: ReturnType<
    typeof createProxyMiddleware<Request, Response>
  >;

  constructor(config: ConfigService) {
    this.proxy = createProxyMiddleware<Request, Response>({
      target: config.getOrThrow<string>('NOTIFICATION_SERVICE_URL'),
      changeOrigin: true,
      ws: true,
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
  }

  use(req: Request, res: Response, next: NextFunction) {
    this.proxy(req, res, next);
  }

  upgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    const upgrade = this.proxy.upgrade as unknown as (
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
      pathname === NOTIFICATION_WS_PATH ||
      pathname.startsWith(`${NOTIFICATION_WS_PATH}/`)
    );
  }
}
