import { describe, it, expect } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { accessTokenUser } from './access-token-user.js';
import { PermissionsGuard } from './guards/permissions.guard.js';
import { PERMISSIONS_KEY } from './decorators/permissions.decorator.js';

describe('shared access token user', () => {
  const payload = { sub: 'user', email: 'user@example.com', tenantId: 'tenant' };

  it('preserves the tenant, role and explicit permissions', () => {
    expect(accessTokenUser({
      ...payload, role: 'MEMBER', permissions: ['order:sales-order:read'],
    })).toEqual({
      id: 'user', email: payload.email, tenantId: 'tenant', role: 'MEMBER',
      isSuperAdmin: false, permissions: ['order:sales-order:read'],
    });
  });

  it('does not invent permissions for legacy or OWNER tokens', () => {
    expect(accessTokenUser(payload).permissions).toEqual([]);
    expect(accessTokenUser({ ...payload, role: 'OWNER' }).permissions).toEqual([]);
  });

  it.each([
    { ...payload, jti: 'refresh-token' },
    { ...payload, sub: '' },
    { ...payload, tenantId: '' },
  ])('rejects refresh or unscoped tokens: %j', (invalid) => {
    expect(() => accessTokenUser(invalid)).toThrow(UnauthorizedException);
  });

  it('rejects malformed authorization claims at runtime', () => {
    for (const invalid of [
      { ...payload, permissions: 'order:sales-order:read' },
      { ...payload, permissions: [true] },
      { ...payload, isSuperAdmin: 'true' },
      { ...payload, role: ['OWNER'] },
    ]) {
      expect(() => accessTokenUser(JSON.parse(JSON.stringify(invalid))))
        .toThrow(UnauthorizedException);
    }
  });

  it('allows explicit read permission but rejects writes and missing claims through the real guard', () => {
    class Controller {
      read() {}
      create() {}
    }
    const controller = new Controller();
    Reflect.defineMetadata(PERMISSIONS_KEY, ['order:sales-order:read'], controller.read);
    Reflect.defineMetadata(PERMISSIONS_KEY, ['order:sales-order:create'], controller.create);
    const guard = new PermissionsGuard(new Reflector());
    function context(method: 'read' | 'create', permissions?: string[]): ExecutionContext {
      return {
        getHandler: () => controller[method],
        getClass: () => Controller,
        switchToHttp: () => ({
          getRequest: () => ({ user: accessTokenUser({ ...payload, permissions }) }),
        }),
      } as ExecutionContext;
    }
    expect(guard.canActivate(context('read', ['order:sales-order:read']))).toBe(true);
    expect(() => guard.canActivate(context('create', ['order:sales-order:read']))).toThrow();
    expect(() => guard.canActivate(context('read'))).toThrow();
  });
});
