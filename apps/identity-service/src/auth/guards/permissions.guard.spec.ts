import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PermissionsGuard } from './permissions.guard.js';

describe('PermissionsGuard', () => {
  let guard: PermissionsGuard;
  let reflector: Reflector;

  beforeEach(() => {
    reflector = new Reflector();
    guard = new PermissionsGuard(reflector);
  });

  const createMockContext = (user?: any): ExecutionContext => {
    return {
      getHandler: vi.fn(),
      getClass: vi.fn(),
      switchToHttp: vi.fn().mockReturnValue({
        getRequest: vi.fn().mockReturnValue({ user }),
      }),
    } as unknown as ExecutionContext;
  };

  it('should allow access if no permissions are required', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
    const context = createMockContext({ id: 'u1' });

    expect(guard.canActivate(context)).toBe(true);
  });

  it('should bypass and allow SUPER_ADMIN across all endpoints', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['iam:role:manage']);
    const context = createMockContext({
      id: 'super-admin-id',
      isSuperAdmin: true,
      role: 'ADMIN',
      permissions: [],
    });

    expect(guard.canActivate(context)).toBe(true);
  });

  it('should bypass and allow tenant OWNER for any tenant operation', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['inventory:stock:adjust']);
    const context = createMockContext({
      id: 'owner-id',
      isSuperAdmin: false,
      role: 'OWNER',
      permissions: ['*'],
    });

    expect(guard.canActivate(context)).toBe(true);
  });

  it('should allow user having the specific permission', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['iam:role:read']);
    const context = createMockContext({
      id: 'user-id',
      isSuperAdmin: false,
      role: 'MEMBER',
      permissions: ['iam:role:read', 'inventory:warehouse:read'],
    });

    expect(guard.canActivate(context)).toBe(true);
  });

  it('should throw ForbiddenException if user lacks the required permission', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['iam:role:manage']);
    const context = createMockContext({
      id: 'user-id',
      isSuperAdmin: false,
      role: 'MEMBER',
      permissions: ['iam:role:read'],
    });

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('should throw ForbiddenException if user is not present on request', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['iam:role:read']);
    const context = createMockContext(undefined);

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });
});
