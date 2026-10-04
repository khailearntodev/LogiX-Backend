import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Reflector } from '@nestjs/core';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { PermissionsGuard } from './permissions.guard.js';

describe('PermissionsGuard (Shared Library @logix/auth)', () => {
  let guard: PermissionsGuard;
  let reflector: Reflector;

  beforeEach(() => {
    reflector = new Reflector();
    guard = new PermissionsGuard(reflector);
  });

  const createMockContext = (user: any): ExecutionContext =>
    ({
      getHandler: vi.fn(),
      getClass: vi.fn(),
      switchToHttp: () => ({
        getRequest: () => ({ user }),
      }),
    }) as unknown as ExecutionContext;

  it('should allow access when no permissions are required', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(null);
    const context = createMockContext({ id: 'user-1' });

    expect(guard.canActivate(context)).toBe(true);
  });

  it('should throw ForbiddenException if user is not present on request', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['inventory:stock:read']);
    const context = createMockContext(null);

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('should allow access if user is SUPER_ADMIN (Platform level bypass)', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['inventory:stock:adjust']);
    const context = createMockContext({
      id: 'super-admin-id',
      isSuperAdmin: true,
      permissions: [],
    });

    expect(guard.canActivate(context)).toBe(true);
  });

  it('should allow access if user is tenant OWNER', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['inventory:stock:adjust']);
    const context = createMockContext({
      id: 'owner-id',
      role: 'OWNER',
      permissions: [],
    });

    expect(guard.canActivate(context)).toBe(true);
  });

  it('should allow access if user permissions include wildcard "*"', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['inventory:stock:adjust']);
    const context = createMockContext({
      id: 'admin-id',
      role: 'ADMIN',
      permissions: ['*'],
    });

    expect(guard.canActivate(context)).toBe(true);
  });

  it('should allow access if user has matching required permission', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['inventory:stock:read']);
    const context = createMockContext({
      id: 'member-id',
      role: 'MEMBER',
      permissions: ['inventory:stock:read', 'order:sales-order:read'],
    });

    expect(guard.canActivate(context)).toBe(true);
  });

  it('should throw ForbiddenException if user lacks required permission', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['inventory:stock:adjust']);
    const context = createMockContext({
      id: 'viewer-id',
      role: 'MEMBER',
      permissions: ['inventory:stock:read'],
    });

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });
});
