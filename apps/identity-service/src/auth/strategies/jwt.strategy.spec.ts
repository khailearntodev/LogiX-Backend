import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { JwtStrategy } from './jwt.strategy.js';
import { PrismaService } from '../../database/prisma.service.js';
import { RolesService } from '../../iam/services/roles.service.js';

describe('Identity JWT strategy', () => {
  const payload = { sub: 'user', email: 'user@example.com', tenantId: 'tenant' };
  const prisma = { user: { findFirst: vi.fn() }, tenant: { findFirst: vi.fn() } };
  const roles = { getEffectivePermissions: vi.fn() };
  let strategy: JwtStrategy;

  beforeEach(async () => {
    vi.resetAllMocks();
    prisma.user.findFirst.mockResolvedValue({
      id: payload.sub, email: payload.email, status: 'ACTIVE', displayName: 'Test',
      userTenants: [{
        tenantId: payload.tenantId, role: 'MEMBER',
        tenant: { name: 'Test tenant', logoUrl: null },
      }],
    });
    roles.getEffectivePermissions.mockResolvedValue({ permissions: ['order:sales-order:read'] });
    const module = await Test.createTestingModule({
      providers: [
        JwtStrategy,
        { provide: PrismaService, useValue: prisma },
        { provide: RolesService, useValue: roles },
        { provide: ConfigService, useValue: new ConfigService({ JWT_SECRET: 'test-only-key-not-a-deployed-secret' }) },
      ],
    }).compile();
    strategy = module.get(JwtStrategy);
  });

  it('uses current IAM rights and scopes membership to an active tenant', async () => {
    const user = await strategy.validate({ ...payload, role: 'OWNER', permissions: ['*'] });
    expect(user.role).toBe('MEMBER');
    expect(user.permissions).toEqual(['order:sales-order:read']);
    expect(roles.getEffectivePermissions).toHaveBeenCalledWith('user', 'tenant');
    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: { id: 'user', status: 'ACTIVE', deletedAt: null },
      include: {
        userTenants: {
          where: {
            tenantId: 'tenant', status: 'ACTIVE', deletedAt: null,
            tenant: { status: 'ACTIVE', deletedAt: null },
          },
          include: { tenant: true },
        },
      },
    });
  });

  it.each([
    { ...payload, jti: 'refresh-token' },
    { ...payload, tenantId: '' },
    { ...payload, sub: '' },
  ])('rejects invalid access-token identity before querying IAM', async (invalid) => {
    await expect(strategy.validate(invalid)).rejects.toThrow(UnauthorizedException);
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
    expect(roles.getEffectivePermissions).not.toHaveBeenCalled();
  });

  it('does not grant access when membership has been removed', async () => {
    prisma.user.findFirst.mockResolvedValue({
      id: 'user', isSuperAdmin: false, userTenants: [],
    });
    await expect(strategy.validate(payload)).rejects.toThrow(UnauthorizedException);
  });

  it('preserves B without membership and uses a context label, not OWNER', async () => {
    prisma.user.findFirst.mockResolvedValue({
      id: 'user', isSuperAdmin: true, userTenants: [],
    });
    prisma.tenant.findFirst.mockResolvedValue({ id: 'tenant', name: 'B', logoUrl: null });
    const result = await strategy.validate({ ...payload, isSuperAdmin: true });
    expect(result).toMatchObject({ tenantId: 'tenant', role: 'SUPER_ADMIN', isSuperAdmin: true, permissions: ['*'] });
  });

  it('rejects an invalid/inactive injected tenant instead of returning stale tenantId', async () => {
    prisma.user.findFirst.mockResolvedValue({
      id: 'user', isSuperAdmin: true, userTenants: [],
    });
    prisma.tenant.findFirst.mockResolvedValue(null);
    await expect(strategy.validate({ ...payload, isSuperAdmin: true })).rejects.toThrow(UnauthorizedException);
    expect(prisma.tenant.findFirst).toHaveBeenCalledWith({
      where: { id: 'tenant', status: 'ACTIVE', deletedAt: null },
    });
  });

  it('keeps a platform-only principal tenantless instead of selecting any membership', async () => {
    prisma.user.findFirst.mockResolvedValue({
      id: 'user', isSuperAdmin: true, userTenants: [],
    });
    const result = await strategy.validate({ ...payload, tenantId: '', isSuperAdmin: true });
    expect(result).toMatchObject({ tenantId: '', role: 'SUPER_ADMIN', isSuperAdmin: true });
    expect(prisma.user.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      include: { userTenants: expect.objectContaining({ where: expect.objectContaining({ tenantId: { in: [] } }) }) },
    }));
    expect(prisma.tenant.findFirst).not.toHaveBeenCalled();
  });
});
