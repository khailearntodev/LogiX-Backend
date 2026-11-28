import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import { gatewayConfigSchema } from '../config/gateway-config.schema.js';
import { AuditProxyMiddleware } from './audit-proxy.middleware.js';

describe('AuditProxyMiddleware (Read-Only Gateway Boundary)', () => {
  const config = {
    getOrThrow: (key: string) => {
      if (key === 'AUDIT_SERVICE_URL') return 'http://localhost:3008';
      throw new Error(`Missing ${key}`);
    },
  } as unknown as ConfigService;

  it('rejects non-GET methods with 405 Method Not Allowed', () => {
    const middleware = new AuditProxyMiddleware(config);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const json = vi.fn();
      const status = vi.fn().mockReturnValue({ json });
      const next = vi.fn();

      middleware.use({ method } as any, { status } as any, next);

      expect(status).toHaveBeenCalledWith(405);
      expect(json).toHaveBeenCalledWith(
        expect.objectContaining({ statusCode: 405, error: 'Method Not Allowed' }),
      );
      expect(next).not.toHaveBeenCalled();
    }
  });

  it('fails fast when AUDIT_SERVICE_URL is missing or malformed', () => {
    const base = {
      MASTER_DATA_SERVICE_URL: 'https://master.example.test',
      IDENTITY_SERVICE_URL: 'https://identity.example.test',
      ORDER_SERVICE_URL: 'https://order.example.test',
      FULFILLMENT_SERVICE_URL: 'https://fulfillment.example.test',
      TRANSPORT_SERVICE_URL: 'https://transport.example.test',
      NOTIFICATION_SERVICE_URL: 'https://notification.example.test',
    };
    expect(gatewayConfigSchema.safeParse(base).success).toBe(false);
    expect(
      gatewayConfigSchema.safeParse({
        ...base,
        AUDIT_SERVICE_URL: 'not-a-url',
      }).success,
    ).toBe(false);
    expect(
      gatewayConfigSchema.safeParse({
        ...base,
        AUDIT_SERVICE_URL: 'https://audit.example.test',
      }).success,
    ).toBe(true);
  });
});
