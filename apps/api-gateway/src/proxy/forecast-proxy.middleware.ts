import { Injectable, NestMiddleware } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { createProxyMiddleware, fixRequestBody, Options } from 'http-proxy-middleware';

const FORECAST_PROXY_TIMEOUT_MS = 60_000;

@Injectable()
export class ForecastProxyMiddleware implements NestMiddleware {
  private readonly proxy: ReturnType<typeof createProxyMiddleware>;

  constructor() {
    const target = process.env.FORECAST_SERVICE_URL || 'http://localhost:8002';

    const options: Options = {
      target,
      changeOrigin: true,
      secure: false,
      timeout: FORECAST_PROXY_TIMEOUT_MS,
      proxyTimeout: FORECAST_PROXY_TIMEOUT_MS,
      pathFilter: (path: string) => path.startsWith('/api/v1/forecast'),
      on: {
        proxyReq: (proxyReq, req: any) => {
          if (req.ip) {
            proxyReq.setHeader('x-forwarded-for', req.ip);
          }
          fixRequestBody(proxyReq, req);
        },
        error: (err, _req, res: any) => {
          console.error('[API Gateway Forecast Proxy Error]:', err.message);
          if (!res.headersSent) {
            res.status(502).json({
              statusCode: 502,
              message: 'Dịch vụ dự báo (Forecast Service) hiện không phản hồi. Vui lòng thử lại sau.',
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
