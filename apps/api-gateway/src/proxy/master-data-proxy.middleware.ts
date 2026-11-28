import { Inject, Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response, NextFunction } from 'express';
import { createProxyMiddleware, fixRequestBody } from 'http-proxy-middleware';
import { DEFAULT_PROXY_TIMEOUT_MS, resolveProxyAgent } from './proxy-agent.js';

/** Resource roots owned by master-data-service. */
const MASTER_DATA_PREFIXES = [
  '/api/v1/customers',
  '/api/v1/products',
  '/api/v1/warehouses',
  '/api/v1/vehicles',
  '/api/v1/drivers',
];

@Injectable()
export class MasterDataProxyMiddleware implements NestMiddleware {
  private readonly logger = new Logger(MasterDataProxyMiddleware.name);
  private readonly proxy: ReturnType<
    typeof createProxyMiddleware<Request, Response>
  >;

  constructor(@Inject(ConfigService) config: ConfigService) {
    const target = config.getOrThrow<string>('MASTER_DATA_SERVICE_URL');
    this.proxy = createProxyMiddleware<Request, Response>({
      target,
      agent: resolveProxyAgent(target),
      timeout: DEFAULT_PROXY_TIMEOUT_MS,
      proxyTimeout: DEFAULT_PROXY_TIMEOUT_MS,
      changeOrigin: true,
      secure: false,
      ws: false,
      pathFilter: (path: string) =>
        MASTER_DATA_PREFIXES.some(
          (prefix) => path === prefix || path.startsWith(`${prefix}/`),
        ),
      on: {
        proxyReq: (proxyReq, req) => {
          if (req.ip) {
            proxyReq.setHeader('x-forwarded-for', req.ip);
          }
          fixRequestBody(proxyReq, req);
        },
        error: (err, _req, res) => {
          this.logger.error(
            { message: err.message },
            'Master Data proxy failed',
          );
          if ('status' in res && !res.headersSent) {
            res.status(502).json({
              statusCode: 502,
              message:
                'Dịch vụ dữ liệu nền (Master Data Service) hiện không phản hồi. Vui lòng thử lại sau.',
              error: 'Bad Gateway',
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
