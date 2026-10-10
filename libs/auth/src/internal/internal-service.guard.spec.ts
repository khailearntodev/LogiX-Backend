import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Reflector } from '@nestjs/core';
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import { InternalServiceGuard } from './internal-service.guard.js';
import {
  INTERNAL_SERVICE_TOKEN_HEADER,
  InternalServiceTokenError,
  signInternalServiceToken,
  verifyInternalServiceToken,
} from './internal-service-token.js';

const SECRET = 'a'.repeat(32);
const OTHER_SECRET = 'b'.repeat(32);
const TARGET = 'order-service';
const CALLER = 'inventory-service';
const TENANT = '11111111-1111-4111-8111-111111111111';

const sign = (overrides: Partial<Parameters<typeof signInternalServiceToken>[0]> = {}) =>
  signInternalServiceToken({
    secret: SECRET,
    service: CALLER,
    audience: TARGET,
    tenantId: TENANT,
    ttlSeconds: 60,
    ...overrides,
  });

describe('internal service token', () => {
  const verifyOptions = { secret: SECRET, audience: TARGET, allowedIssuers: [CALLER] };

  it('round-trips caller, audience and tenant', () => {
    expect(verifyInternalServiceToken(sign(), verifyOptions)).toEqual({
      service: CALLER,
      audience: TARGET,
      tenantId: TENANT,
    });
  });

  it.each([
    ['short secret', { secret: 'short' }],
    ['empty tenant', { tenantId: '' }],
    ['zero ttl', { ttlSeconds: 0 }],
    ['ttl above max', { ttlSeconds: 301 }],
  ])('refuses to sign with %s', (_label, overrides) => {
    expect(() => sign(overrides)).toThrow(InternalServiceTokenError);
  });

  it('rejects a token signed with another secret', () => {
    expect(() => verifyInternalServiceToken(sign({ secret: OTHER_SECRET }), verifyOptions)).toThrow(
      InternalServiceTokenError,
    );
  });

  it('rejects an expired token', () => {
    const expired = jwt.sign(
      { typ: 'internal-service', tenantId: TENANT, exp: Math.floor(Date.now() / 1000) - 10 },
      SECRET,
      { algorithm: 'HS256', issuer: CALLER, audience: TARGET },
    );
    expect(() => verifyInternalServiceToken(expired, verifyOptions)).toThrow(/expired/);
  });

  it('rejects a token without expiry', () => {
    const noExp = jwt.sign({ typ: 'internal-service', tenantId: TENANT }, SECRET, {
      algorithm: 'HS256',
      issuer: CALLER,
      audience: TARGET,
    });
    expect(() => verifyInternalServiceToken(noExp, verifyOptions)).toThrow(/must expire/);
  });

  it('rejects a token without tenant', () => {
    const noTenant = jwt.sign({ typ: 'internal-service' }, SECRET, {
      algorithm: 'HS256',
      issuer: CALLER,
      audience: TARGET,
      expiresIn: 60,
    });
    expect(() => verifyInternalServiceToken(noTenant, verifyOptions)).toThrow(/tenantId/);
  });

  it('rejects a user access token signed with the same secret', () => {
    const userToken = jwt.sign({ sub: 'u1', tenantId: TENANT }, SECRET, {
      algorithm: 'HS256',
      issuer: CALLER,
      audience: TARGET,
      expiresIn: 60,
    });
    expect(() => verifyInternalServiceToken(userToken, verifyOptions)).toThrow(/unexpected type/);
  });

  it('rejects wrong audience and unlisted issuer', () => {
    expect(() => verifyInternalServiceToken(sign({ audience: 'billing-service' }), verifyOptions)).toThrow(
      InternalServiceTokenError,
    );
    expect(() => verifyInternalServiceToken(sign({ service: 'unknown-service' }), verifyOptions)).toThrow(
      InternalServiceTokenError,
    );
  });

  it('rejects when no caller is allowed', () => {
    expect(() => verifyInternalServiceToken(sign(), { ...verifyOptions, allowedIssuers: [] })).toThrow(
      /No internal caller/,
    );
  });

  it('rejects the none algorithm', () => {
    const unsigned = jwt.sign({ typ: 'internal-service', tenantId: TENANT }, '', {
      algorithm: 'none',
      issuer: CALLER,
      audience: TARGET,
      expiresIn: 60,
    });
    expect(() => verifyInternalServiceToken(unsigned, verifyOptions)).toThrow(InternalServiceTokenError);
  });
});

describe('InternalServiceGuard', () => {
  let reflector: Reflector;
  let guard: InternalServiceGuard;

  beforeEach(() => {
    reflector = new Reflector();
    guard = new InternalServiceGuard(reflector, { secret: SECRET, serviceName: TARGET });
  });

  const createContext = (request: Record<string, any>): ExecutionContext =>
    ({
      getHandler: vi.fn(),
      getClass: vi.fn(),
      switchToHttp: () => ({ getRequest: () => request }),
    }) as unknown as ExecutionContext;

  it('accepts an allowed caller and attaches the verified claims', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue([CALLER]);
    const request = { headers: { [INTERNAL_SERVICE_TOKEN_HEADER]: sign() } } as Record<string, any>;

    expect(guard.canActivate(createContext(request))).toBe(true);
    expect(request.internalCaller).toEqual({ service: CALLER, audience: TARGET, tenantId: TENANT });
  });

  it('rejects a request without the internal token header', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue([CALLER]);
    expect(() => guard.canActivate(createContext({ headers: {} }))).toThrow(UnauthorizedException);
  });

  it('fails closed when the endpoint declares no allowed callers', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
    const request = { headers: { [INTERNAL_SERVICE_TOKEN_HEADER]: sign() } };
    expect(() => guard.canActivate(createContext(request))).toThrow(UnauthorizedException);
  });

  it('rejects a token with an invalid signature', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue([CALLER]);
    const request = { headers: { [INTERNAL_SERVICE_TOKEN_HEADER]: sign({ secret: OTHER_SECRET }) } };
    expect(() => guard.canActivate(createContext(request))).toThrow(UnauthorizedException);
  });
});
