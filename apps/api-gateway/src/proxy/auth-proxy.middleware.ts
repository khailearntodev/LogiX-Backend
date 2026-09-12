import { Injectable, NestMiddleware } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { createProxyMiddleware, Options } from 'http-proxy-middleware';

@Injectable()
export class AuthProxyMiddleware implements NestMiddleware {
  private readonly proxy: ReturnType<typeof createProxyMiddleware>;

  constructor() {
    const target = process.env.IDENTITY_SERVICE_URL || 'http://localhost:3001';

    const options: Options = {
      target,
      changeOrigin: true,
      secure: false,
      ws: true,
      pathFilter: '/api/v1/auth',
      on: {
        proxyReq: (proxyReq, req: any) => {
          // Preserve client IP and headers
          if (req.ip) {
            proxyReq.setHeader('x-forwarded-for', req.ip);
          }
        },
        error: (err, _req, res: any) => {
          console.error('[API Gateway Auth Proxy Error]:', err.message);
          if (!res.headersSent) {
            res.status(502).json({
              statusCode: 502,
              message: 'Dịch vụ xác thực (Identity Service) hiện không phản hồi. Vui lòng thử lại sau.',
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
