import { Inject, Injectable, NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response, NextFunction } from 'express';
import { createProxyMiddleware, fixRequestBody, Options } from 'http-proxy-middleware';
import { resolveProxyAgent } from './proxy-agent.js';

const FORECAST_PROXY_TIMEOUT_MS = 60_000;

@Injectable()
export class ForecastProxyMiddleware implements NestMiddleware {
  private readonly proxy: ReturnType<typeof createProxyMiddleware> | null;

  constructor(@Inject(ConfigService) config: ConfigService) {
    const target = config.get<string>('FORECAST_SERVICE_URL');
    if (!target) {
      this.proxy = null;
      return;
    }

    const options: Options = {
      target,
      agent: resolveProxyAgent(target),
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
    if (!this.proxy) {
      res.status(503).json({
        statusCode: 503,
        message: 'Dịch vụ dự báo (Forecast Service) chưa được cấu hình trên hệ thống.',
        error: 'Service Unavailable',
      });
      return;
    }
    this.proxy(req, res, next);
  }
}
