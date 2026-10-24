import { Inject, Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response, NextFunction } from 'express';
import { createProxyMiddleware, fixRequestBody } from 'http-proxy-middleware';

@Injectable()
export class AuthProxyMiddleware implements NestMiddleware {
  private readonly logger = new Logger(AuthProxyMiddleware.name);
  private readonly proxy: ReturnType<
    typeof createProxyMiddleware<Request, Response>
  >;

  constructor(@Inject(ConfigService) config: ConfigService) {
    this.proxy = createProxyMiddleware<Request, Response>({
      target: config.getOrThrow<string>('IDENTITY_SERVICE_URL'),
      changeOrigin: true,
      secure: false,
      ws: true,
      pathFilter: (path: string) =>
        ['/api/v1/auth', '/api/v1/iam', '/api/v1/admin'].some(
          (prefix) => path === prefix || path.startsWith(`${prefix}/`),
        ),
      on: {
        proxyReq: (proxyReq, req) => {
          // Preserve client IP and headers
          if (req.ip) {
            proxyReq.setHeader('x-forwarded-for', req.ip);
          }
          // Re-stream request body parsed by Express body-parser
          fixRequestBody(proxyReq, req);
        },
        error: (err, _req, res) => {
          this.logger.error({ message: err.message }, 'Identity proxy failed');
          if ('status' in res && !res.headersSent) {
            res.status(502).json({
              statusCode: 502,
              message:
                'Dịch vụ xác thực (Identity Service) hiện không phản hồi. Vui lòng thử lại sau.',
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
