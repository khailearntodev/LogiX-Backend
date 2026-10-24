import { Test } from '@nestjs/testing';
import { AuthService } from './auth.service.js';
import { TokenService } from './token.service.js';
import { PrismaService } from '../../database/prisma.service.js';
import { RolesService } from '../../iam/services/roles.service.js';
import { OrganizationService } from '../../organizations/services/organization.service.js';
import { MailService } from '../../mail/services/mail.service.js';

describe('Super Admin context invariants', () => {
  const tenant = {
    id: 'B',
    code: 'B',
    name: 'Destination',
    status: 'ACTIVE',
    deletedAt: null,
    logoUrl: null,
    addressLine: null,
    province: null,
  };
  const user = {
    id: 'admin',
    email: 'qa@example.test',
    status: 'ACTIVE',
    deletedAt: null,
    isSuperAdmin: true,
    userTenants: [
      {
        id: 'membership-A',
        tenantId: 'A',
        role: 'MEMBER',
        isDefault: true,
        tenant: { ...tenant, id: 'A', code: 'A', name: 'Original' },
      },
    ],
  };
  const prisma = {
    user: { findFirst: vi.fn(), findUnique: vi.fn() },
    tenant: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    userTenant: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
  };
  const tokens = {
    generateAccessToken: vi.fn(() => 'access'),
    generateRefreshToken: vi.fn(() => 'refresh'),
    createSession: vi.fn(),
  };
  const roles = { getEffectivePermissions: vi.fn() };
  let auth: AuthService;
  let organizations: OrganizationService;

  beforeEach(async () => {
    vi.resetAllMocks();
    prisma.user.findFirst.mockResolvedValue(user);
    prisma.user.findUnique.mockResolvedValue(user);
    prisma.tenant.findFirst.mockResolvedValue(tenant);
    prisma.tenant.findMany.mockResolvedValue([
      user.userTenants[0].tenant,
      tenant,
    ]);
    prisma.tenant.update.mockResolvedValue(tenant);
    prisma.userTenant.findFirst.mockResolvedValue(null);
    prisma.userTenant.findMany.mockResolvedValue([]);
    tokens.generateAccessToken.mockReturnValue('access');
    tokens.generateRefreshToken.mockReturnValue('refresh');
    roles.getEffectivePermissions.mockResolvedValue({ permissions: ['*'] });
    const module = await Test.createTestingModule({
      providers: [
        AuthService,
        OrganizationService,
        { provide: PrismaService, useValue: prisma },
        { provide: TokenService, useValue: tokens },
        { provide: RolesService, useValue: roles },
        { provide: MailService, useValue: {} },
      ],
    }).compile();
    auth = module.get(AuthService);
    organizations = module.get(OrganizationService);
  });

  it('switches to B without fabricating or mutating membership/default/role', async () => {
    const result = await auth.switchTenant(user.id, { tenantId: 'B' });
    expect(result.activeTenant).toMatchObject({ id: 'B', role: 'SUPER_ADMIN' });
    expect(tokens.generateAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'B',
        role: 'SUPER_ADMIN',
        isSuperAdmin: true,
        permissions: ['*'],
      }),
    );
    expect(prisma.userTenant.create).not.toHaveBeenCalled();
    expect(prisma.userTenant.update).not.toHaveBeenCalled();
  });

  it('hydrates B instead of falling back to membership A, and keeps persisted default A', async () => {
    const result = await auth.getProfile(user.id, 'B');
    expect(result.activeTenant).toMatchObject({
      id: 'B',
      name: 'Destination',
      role: 'SUPER_ADMIN',
    });
    expect(result.tenants).toEqual([
      expect.objectContaining({ id: 'A', role: 'MEMBER', isDefault: true }),
      expect.objectContaining({
        id: 'B',
        role: 'SUPER_ADMIN',
        isDefault: false,
      }),
    ]);
  });

  it('never substitutes A when B is inaccessible', async () => {
    prisma.tenant.findFirst.mockResolvedValue(null);
    await expect(auth.getProfile(user.id, 'B')).rejects.toMatchObject({
      status: 401,
    });
  });

  it('retains the existing all-active-tenant switcher for a Super Admin with no memberships', async () => {
    prisma.user.findUnique.mockResolvedValue({ ...user, userTenants: [] });
    const result = await auth.getProfile(user.id, 'B');
    expect(result.activeTenant).toMatchObject({ id: 'B', role: 'SUPER_ADMIN' });
    expect(result.tenants).toEqual([
      expect.objectContaining({
        id: 'A',
        role: 'SUPER_ADMIN',
        isDefault: false,
      }),
      expect.objectContaining({
        id: 'B',
        role: 'SUPER_ADMIN',
        isDefault: false,
      }),
    ]);
  });

  it('rejects stale injected context after account flag is revoked', async () => {
    prisma.user.findUnique.mockResolvedValue({ ...user, isSuperAdmin: false });
    await expect(auth.getProfile(user.id, 'B')).rejects.toMatchObject({
      status: 401,
    });
  });

  it('reads and updates B without membership while retaining the platform context label', async () => {
    expect(await organizations.getOrganization(user.id, 'B')).toMatchObject({
      id: 'B',
      role: 'SUPER_ADMIN',
      isDefault: false,
    });
    expect(
      await organizations.updateOrganization(user.id, 'B', {
        name: 'Destination',
      }),
    ).toMatchObject({ id: 'B', role: 'SUPER_ADMIN' });
    expect(await organizations.getMembers(user.id, 'B')).toEqual([]);
  });

  it('retains legal address validation for a Super Admin', async () => {
    await expect(
      organizations.updateOrganization(user.id, 'B', { addressLine: 'Street' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  it('does not apply membership-only set-default or leave to an injected organization', async () => {
    await expect(
      organizations.setDefaultTenant(user.id, 'B'),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      organizations.leaveOrganization(user.id, 'B'),
    ).rejects.toMatchObject({ status: 404 });
    expect(prisma.userTenant.create).not.toHaveBeenCalled();
    expect(prisma.userTenant.update).not.toHaveBeenCalled();
  });
});
