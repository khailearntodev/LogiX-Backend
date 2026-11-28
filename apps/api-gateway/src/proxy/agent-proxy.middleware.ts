import { Inject, Injectable, NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response, NextFunction } from 'express';
import { createProxyMiddleware, fixRequestBody, Options } from 'http-proxy-middleware';
import { resolveProxyAgent } from './proxy-agent.js';

// LLM runs are slow and streamed over SSE, so timeouts are far above the other proxies.
const AGENT_PROXY_TIMEOUT_MS = 120_000;

@Injectable()
export class AgentProxyMiddleware implements NestMiddleware {
  private readonly proxy: ReturnType<typeof createProxyMiddleware> | null;

  constructor(@Inject(ConfigService) config: ConfigService) {
    const target = config.get<string>('AGENT_SERVICE_URL');
    if (!target) {
      this.proxy = null;
      return;
    }

    const options: Options = {
      target,
      agent: resolveProxyAgent(target),
      changeOrigin: true,
      secure: false,
      timeout: AGENT_PROXY_TIMEOUT_MS,
      proxyTimeout: AGENT_PROXY_TIMEOUT_MS,
      pathFilter: (path: string) => path.startsWith('/api/v1/agent'),
      on: {
        proxyReq: (proxyReq, req: any) => {
          if (req.ip) {
            proxyReq.setHeader('x-forwarded-for', req.ip);
          }
          // Re-stream request body parsed by Express body-parser
          fixRequestBody(proxyReq, req);
        },
        proxyRes: (proxyRes) => {
          // Keep reverse proxies in front of the gateway from buffering the SSE stream
          if (String(proxyRes.headers['content-type'] ?? '').startsWith('text/event-stream')) {
            proxyRes.headers['cache-control'] = 'no-cache';
            proxyRes.headers['x-accel-buffering'] = 'no';
          }
        },
        error: (err, _req, res: any) => {
          console.error('[API Gateway Agent Proxy Error]:', err.message);
          if (!res.headersSent) {
            res.status(502).json({
              statusCode: 502,
              message: 'Dịch vụ AI (Agent Service) hiện không phản hồi. Vui lòng thử lại sau.',
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
        message: 'Dịch vụ AI (Agent Service) chưa được cấu hình trên hệ thống.',
        error: 'Service Unavailable',
      });
      return;
    }
    this.proxy(req, res, next);
  }
}
