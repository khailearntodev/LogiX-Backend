import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host.js';
import { SuperAdminGuard } from './super-admin.guard.js';

describe('SuperAdminGuard', () => {
  const guard = new SuperAdminGuard();
  const context = (user?: unknown) => new ExecutionContextHost([{ user }]);

  it.each([
    { isSuperAdmin: true },
    { isSuperAdmin: true, role: 'MEMBER', permissions: [], tenantId: '' },
  ])('allows account-level authority without a tenant role: %j', (user) => {
    expect(guard.canActivate(context(user))).toBe(true);
  });

  it('rejects an absent principal as unauthenticated', () => {
    expect(() => guard.canActivate(context())).toThrow(UnauthorizedException);
  });

  it.each([
    {},
    { isSuperAdmin: false },
    { isSuperAdmin: 'true' },
    { isSuperAdmin: 1 },
    { role: 'OWNER', permissions: ['*'] },
    { role: 'ADMIN', isSuperAdmin: false },
  ])('denies non-boolean or missing authority: %j', (user) => {
    expect(() => guard.canActivate(context(user))).toThrow(ForbiddenException);
  });
});
