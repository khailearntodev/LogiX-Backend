import { Inject, Injectable, NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response, NextFunction } from 'express';
import { createProxyMiddleware, fixRequestBody, Options } from 'http-proxy-middleware';
import { DEFAULT_PROXY_TIMEOUT_MS, resolveProxyAgent } from './proxy-agent.js';

@Injectable()
export class InventoryProxyMiddleware implements NestMiddleware {
  private readonly proxy: ReturnType<typeof createProxyMiddleware> | null;

  constructor(@Inject(ConfigService) config: ConfigService) {
    const target = config.get<string>('INVENTORY_SERVICE_URL');
    if (!target) {
      this.proxy = null;
      return;
    }

    const options: Options = {
      target,
      agent: resolveProxyAgent(target),
      timeout: DEFAULT_PROXY_TIMEOUT_MS,
      proxyTimeout: DEFAULT_PROXY_TIMEOUT_MS,
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
    if (!this.proxy) {
      res.status(503).json({
        statusCode: 503,
        message: 'Dịch vụ tồn kho (Inventory Service) chưa được cấu hình trên hệ thống.',
        error: 'Service Unavailable',
      });
      return;
    }
    this.proxy(req, res, next);
  }
}
