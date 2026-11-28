import { Injectable, NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NextFunction, Request, Response } from 'express';
import { createProxyMiddleware, type Options } from 'http-proxy-middleware';
import { DEFAULT_PROXY_TIMEOUT_MS, resolveProxyAgent } from './proxy-agent.js';

// Strictly read-only public audit query prefix (BR-AUD-002, NFR-AUD-001).
const AUDIT_PUBLIC_PREFIX = '/api/v1/audit-logs';

@Injectable()
export class AuditProxyMiddleware implements NestMiddleware {
  private readonly proxy: ReturnType<typeof createProxyMiddleware>;

  constructor(config: ConfigService) {
    const target = config.getOrThrow<string>('AUDIT_SERVICE_URL');
    const options: Options = {
      target,
      agent: resolveProxyAgent(target),
      timeout: DEFAULT_PROXY_TIMEOUT_MS,
      proxyTimeout: DEFAULT_PROXY_TIMEOUT_MS,
      changeOrigin: true,
      pathFilter: (path: string) =>
        path === AUDIT_PUBLIC_PREFIX ||
        path.startsWith(`${AUDIT_PUBLIC_PREFIX}/`),
      on: {
        proxyReq: (proxyReq, req) => {
          const expressReq = req as Request;
          if (expressReq.ip) {
            proxyReq.setHeader('x-forwarded-for', expressReq.ip);
          }
        },
        error: (err, _req, res: any) => {
          console.error('[API Gateway Audit Proxy Error]:', err.message);
          if (!res.headersSent) {
            res.status(502).json({
              statusCode: 502,
              message:
                'Dịch vụ nhật ký kiểm toán (Audit Service) hiện không phản hồi. Vui lòng thử lại sau.',
              error: 'Bad Gateway',
            });
          }
        },
      },
    };

    this.proxy = createProxyMiddleware(options);
  }

  use(req: Request, res: Response, next: NextFunction) {
    if (req.method !== 'GET') {
      res.status(405).json({
        statusCode: 405,
        message: 'Nhật ký kiểm toán là bất biến và chỉ hỗ trợ truy vấn đọc (GET).',
        error: 'Method Not Allowed',
      });
      return;
    }
    this.proxy(req, res, next);
  }
}
