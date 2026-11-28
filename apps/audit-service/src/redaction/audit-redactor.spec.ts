import { describe, expect, it } from 'vitest';
import {
  CIRCULAR_VALUE,
  REDACTED_VALUE,
  TRUNCATED_VALUE,
  redactAuditPayload,
} from './audit-redactor.js';

describe('redactAuditPayload', () => {
  it('recursively redacts sensitive keys regardless of casing or hyphen/underscore style', () => {
    const input = {
      orderNumber: 'ORD-001',
      password: 'plain-password',
      PasswordHash: '$2b$10$hash',
      access_token: 'abc',
      'x-api-key': 'my-key',
      nested: {
        refreshToken: 'refresh-123',
        clientSecret: 'sec-456',
        authorization: 'CustomAuth xyz',
        cookie: 'session=abc',
        safeField: 'kept',
      },
      list: [{ sku: 'SKU-1', otpCode: '123456' }],
    };

    const result = redactAuditPayload(input) as Record<string, any>;

    expect(result.orderNumber).toBe('ORD-001');
    expect(result.password).toBe(REDACTED_VALUE);
    expect(result.PasswordHash).toBe(REDACTED_VALUE);
    expect(result.access_token).toBe(REDACTED_VALUE);
    expect(result['x-api-key']).toBe(REDACTED_VALUE);
    expect(result.nested.refreshToken).toBe(REDACTED_VALUE);
    expect(result.nested.clientSecret).toBe(REDACTED_VALUE);
    expect(result.nested.authorization).toBe(REDACTED_VALUE);
    expect(result.nested.cookie).toBe(REDACTED_VALUE);
    expect(result.nested.safeField).toBe('kept');
    expect(result.list[0].sku).toBe('SKU-1');
    expect(result.list[0].otpCode).toBe(REDACTED_VALUE);
  });

  it('redacts JWTs, Bearer headers, API keys, and DB URIs even under innocent key names', () => {
    const input = {
      note: 'Bearer supersecrettokenvalue12345',
      rawJwt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyLTEifQ.signature1234567890',
      providerKey: 'sk-1234567890abcdefghij',
      dsn: 'postgresql://audit_app:secretpass@localhost:5433/logix_audit',
      normal: 'Kho Hà Nội - Đơn hàng đã xác nhận',
    };

    const result = redactAuditPayload(input) as Record<string, unknown>;

    expect(result.note).toBe(REDACTED_VALUE);
    expect(result.rawJwt).toBe(REDACTED_VALUE);
    expect(result.providerKey).toBe(REDACTED_VALUE);
    expect(result.dsn).toBe(REDACTED_VALUE);
    expect(result.normal).toBe('Kho Hà Nội - Đơn hàng đã xác nhận');
  });

  it('handles circular references, BigInt values, Dates, and max depth safely', () => {
    const circular: Record<string, unknown> = {
      version: 42n,
      createdAt: new Date('2026-11-24T00:00:00.000Z'),
    };
    circular.self = circular;

    const result = redactAuditPayload(circular, { maxDepth: 3 }) as Record<string, unknown>;
    expect(result.version).toBe('42');
    expect(result.createdAt).toBe('2026-11-24T00:00:00.000Z');
    expect(result.self).toBe(CIRCULAR_VALUE);

    const deep = { a: { b: { c: { d: 'leaf' } } } };
    const truncated = redactAuditPayload(deep, { maxDepth: 2 }) as any;
    expect(truncated.a.b).toBe(TRUNCATED_VALUE);
  });
});
