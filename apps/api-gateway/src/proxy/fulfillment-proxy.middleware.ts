import { Injectable, Logger, type NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response, NextFunction } from 'express';
import { createProxyMiddleware, fixRequestBody } from 'http-proxy-middleware';

const PUBLIC_PREFIX = '/api/v1/shipments';
@Injectable()
export class FulfillmentProxyMiddleware implements NestMiddleware {
  private readonly logger = new Logger(FulfillmentProxyMiddleware.name);
  private readonly proxy: ReturnType<
    typeof createProxyMiddleware<Request, Response>
  >;
  constructor(config: ConfigService) {
    this.proxy = createProxyMiddleware<Request, Response>({
      target: config.getOrThrow<string>('FULFILLMENT_SERVICE_URL'),
      changeOrigin: true,
      pathFilter: (path) =>
        path === PUBLIC_PREFIX || path.startsWith(`${PUBLIC_PREFIX}/`),
      on: {
        proxyReq: (proxyReq, req) => {
          if (req.ip) proxyReq.setHeader('x-forwarded-for', req.ip);
          fixRequestBody(proxyReq, req);
        },
        error: (error, _req, res) => {
          this.logger.error(
            { message: error.message },
            'Fulfillment proxy failed',
          );
          if ('status' in res && !res.headersSent)
            res.status(502).json({
              statusCode: 502,
              error: 'Bad Gateway',
              message: 'Dịch vụ chuẩn bị hàng chưa phản hồi. Vui lòng thử lại.',
            });
        },
      },
    });
  }
  use(req: Request, res: Response, next: NextFunction) {
    this.proxy(req, res, next);
  }
}
