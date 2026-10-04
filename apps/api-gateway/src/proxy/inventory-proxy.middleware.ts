import { Injectable, NestMiddleware } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { createProxyMiddleware, fixRequestBody, Options } from 'http-proxy-middleware';

@Injectable()
export class InventoryProxyMiddleware implements NestMiddleware {
  private readonly proxy: ReturnType<typeof createProxyMiddleware>;

  constructor() {
    const target = process.env.INVENTORY_SERVICE_URL || 'http://localhost:3004';

    const options: Options = {
      target,
      changeOrigin: true,
      secure: false,
      pathFilter: (path: string) => path.startsWith('/api/v1/inventory'),
      on: {
        proxyReq: (proxyReq, req: any) => {
          // Preserve client IP and headers
          if (req.ip) {
            proxyReq.setHeader('x-forwarded-for', req.ip);
          }
          // Re-stream request body parsed by Express body-parser
          fixRequestBody(proxyReq, req);
        },
        error: (err, _req, res: any) => {
          console.error('[API Gateway Inventory Proxy Error]:', err.message);
          if (!res.headersSent) {
            res.status(502).json({
              statusCode: 502,
              message: 'Dịch vụ tồn kho (Inventory Service) hiện không phản hồi. Vui lòng thử lại sau.',
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
