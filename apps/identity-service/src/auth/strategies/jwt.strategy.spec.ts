import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { JwtStrategy } from './jwt.strategy.js';
import { PrismaService } from '../../database/prisma.service.js';
import { RolesService } from '../../iam/services/roles.service.js';

describe('Identity JWT strategy', () => {
  const payload = { sub: 'user', email: 'user@example.com', tenantId: 'tenant' };
  const prisma = { user: { findFirst: vi.fn() } };
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
});
