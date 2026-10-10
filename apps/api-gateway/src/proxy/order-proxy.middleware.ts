import { Injectable, NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response, NextFunction } from 'express';
import { createProxyMiddleware, fixRequestBody, Options } from 'http-proxy-middleware';

// Only public order routes are forwarded; order-service internal endpoints
// (/api/v1/internal/*) are intentionally never exposed through the gateway.
const ORDER_PUBLIC_PREFIX = '/api/v1/orders';

@Injectable()
export class OrderProxyMiddleware implements NestMiddleware {
  private readonly proxy: ReturnType<typeof createProxyMiddleware>;

  constructor(config: ConfigService) {
    const options: Options = {
      target: config.getOrThrow<string>('ORDER_SERVICE_URL'),
      changeOrigin: true,
      pathFilter: (path: string) =>
        path === ORDER_PUBLIC_PREFIX || path.startsWith(`${ORDER_PUBLIC_PREFIX}/`),
      on: {
        proxyReq: (proxyReq, req: any) => {
          if (req.ip) {
            proxyReq.setHeader('x-forwarded-for', req.ip);
          }
          // Re-stream request body parsed by Express body-parser
          fixRequestBody(proxyReq, req);
        },
        error: (err, _req, res: any) => {
          console.error('[API Gateway Order Proxy Error]:', err.message);
          if (!res.headersSent) {
            res.status(502).json({
              statusCode: 502,
              message: 'Dịch vụ đơn hàng (Order Service) hiện không phản hồi. Vui lòng thử lại sau.',
              error: 'Bad Gateway',
            });
          }
        },
      },
    };

    this.proxy = createProxyMiddleware(options);
  }

  use(req: Request, res: Response, next: NextFunction) {
    this.proxy(req, res, next);
  }
}
