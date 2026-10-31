import { Inject, Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response, NextFunction } from 'express';
import { createProxyMiddleware, fixRequestBody } from 'http-proxy-middleware';

const TRIPS_PREFIX = '/api/v1/trips';
const DRIVER_TRIPS_PREFIX = '/api/v1/driver/trips';

@Injectable()
export class TransportProxyMiddleware implements NestMiddleware {
  private readonly logger = new Logger(TransportProxyMiddleware.name);
  private readonly proxy: ReturnType<
    typeof createProxyMiddleware<Request, Response>
  >;

  constructor(@Inject(ConfigService) config: ConfigService) {
    this.proxy = createProxyMiddleware<Request, Response>({
      target: config.getOrThrow<string>('TRANSPORT_SERVICE_URL'),
      changeOrigin: true,
      ws: false,
      pathFilter: (path: string) =>
        path === TRIPS_PREFIX ||
        path.startsWith(`${TRIPS_PREFIX}/`) ||
        path === DRIVER_TRIPS_PREFIX ||
        path.startsWith(`${DRIVER_TRIPS_PREFIX}/`),
      on: {
        proxyReq: (proxyReq, req) => {
          if (req.ip) proxyReq.setHeader('x-forwarded-for', req.ip);
          fixRequestBody(proxyReq, req);
        },
        error: (error, _req, res) => {
          this.logger.error(
            { message: error.message },
            'Transport proxy failed',
          );
          if ('status' in res && !res.headersSent) {
            res.status(502).json({
              statusCode: 502,
              error: 'BAD_GATEWAY',
              message: 'Dịch vụ chuyến giao hiện không phản hồi.',
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
