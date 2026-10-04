import { Injectable, NestMiddleware } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import {
  createProxyMiddleware,
  fixRequestBody,
  Options,
} from 'http-proxy-middleware';

/** Resource roots owned by master-data-service. */
const MASTER_DATA_PREFIXES = [
  '/api/v1/customers',
  '/api/v1/products',
  '/api/v1/warehouses',
  '/api/v1/vehicles',
];

@Injectable()
export class MasterDataProxyMiddleware implements NestMiddleware {
  private readonly proxy: ReturnType<typeof createProxyMiddleware>;

  constructor() {
    const target =
      process.env.MASTER_DATA_SERVICE_URL || 'http://localhost:3003';

    const options: Options = {
      target,
      changeOrigin: true,
      secure: false,
      ws: false,
      pathFilter: (path: string) =>
        MASTER_DATA_PREFIXES.some((prefix) => path.startsWith(prefix)),
      on: {
        proxyReq: (proxyReq, req: any) => {
          if (req.ip) {
            proxyReq.setHeader('x-forwarded-for', req.ip);
          }
          fixRequestBody(proxyReq, req);
        },
        error: (err, _req, res: any) => {
          console.error('[API Gateway Master Data Proxy Error]:', err.message);
          if (!res.headersSent) {
            res.status(502).json({
              statusCode: 502,
              message:
                'Dịch vụ dữ liệu nền (Master Data Service) hiện không phản hồi. Vui lòng thử lại sau.',
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
