import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createProxyMiddleware,
  fixRequestBody,
} from 'http-proxy-middleware';
import type { Request, Response, NextFunction } from 'express';
import { DEFAULT_PROXY_TIMEOUT_MS, resolveProxyAgent } from './proxy-agent.js';

const NOTIFICATION_PREFIX = '/api/v1/notifications';

@Injectable()
export class NotificationProxyMiddleware implements NestMiddleware {
  private readonly logger = new Logger(NotificationProxyMiddleware.name);
  private readonly proxy: ReturnType<
    typeof createProxyMiddleware<Request, Response>
  >;

  constructor(config: ConfigService) {
    const target = config.getOrThrow<string>('NOTIFICATION_SERVICE_URL');
    this.proxy = createProxyMiddleware<Request, Response>({
      target,
      agent: resolveProxyAgent(target),
      timeout: DEFAULT_PROXY_TIMEOUT_MS,
      proxyTimeout: DEFAULT_PROXY_TIMEOUT_MS,
      changeOrigin: true,
      ws: true,
      pathFilter: (path: string) =>
        path === NOTIFICATION_PREFIX || path.startsWith(`${NOTIFICATION_PREFIX}/`),
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
}
