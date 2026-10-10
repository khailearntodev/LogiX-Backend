import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { OrganizationService } from './organization.service.js';
import { PrismaService } from '../../database/prisma.service.js';
import { RolesService } from '../../iam/services/roles.service.js';

describe('OrganizationService', () => {
  let organizationService: OrganizationService;
  let prismaService: any;
  let rolesService: any;

  beforeEach(async () => {
    rolesService = {
      initializeTenantRoles: vi.fn().mockResolvedValue({}),
    };

    prismaService = {
      user: {
        findFirst: vi.fn(),
        findUnique: vi.fn(),
      },
      tenant: {
        findUnique: vi.fn(),
        findFirst: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
      userTenant: {
        findFirst: vi.fn(),
        findMany: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        count: vi.fn().mockResolvedValue(0),
      },
      tenantInvitation: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      session: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      userRole: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: vi.fn((promises) => Promise.all(promises)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrganizationService,
        { provide: PrismaService, useValue: prismaService },
        { provide: RolesService, useValue: rolesService },
      ],
    }).compile();

    organizationService = module.get<OrganizationService>(OrganizationService);
  });

  describe('getTenants', () => {
    it('should throw UnauthorizedException if user does not exist or is inactive', async () => {
      prismaService.user.findFirst.mockResolvedValue(null);

      await expect(organizationService.getTenants('invalid_id')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should return list of active tenants the user belongs to', async () => {
      prismaService.user.findFirst.mockResolvedValue({
        id: 'u1',
        status: 'ACTIVE',
        userTenants: [
          {
            role: 'OWNER',
            isDefault: true,
            tenant: { id: 't1', code: 'logix-hq', name: 'LogiX HQ', logoUrl: 'https://logo.png' },
          },
          {
            role: 'MEMBER',
            isDefault: false,
            tenant: { id: 't2', code: 'logix-branch', name: 'LogiX Branch', logoUrl: null },
          },
        ],
      });

      const tenants = await organizationService.getTenants('u1');
      expect(tenants).toHaveLength(2);
      expect(tenants[0]).toEqual({
        id: 't1',
        code: 'logix-hq',
        name: 'LogiX HQ',
        logoUrl: 'https://logo.png',
        role: 'OWNER',
        isDefault: true,
      });
      expect(tenants[1]).toEqual({
        id: 't2',
        code: 'logix-branch',
        name: 'LogiX Branch',
        logoUrl: null,
        role: 'MEMBER',
        isDefault: false,
      });
    });
  });

  describe('createOrganization', () => {
    it('should throw UnauthorizedException if user is inactive or not found', async () => {
      prismaService.user.findFirst.mockResolvedValue(null);

      await expect(
        organizationService.createOrganization('u1', { name: 'Org Name' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should create organization for logged in user', async () => {
      prismaService.user.findFirst.mockResolvedValue({ id: 'u1', status: 'ACTIVE' });
      prismaService.tenant.create.mockResolvedValue({ id: 'new_t', code: 'tenant-99', name: 'New Logistics Co' });
      prismaService.userTenant.create.mockResolvedValue({ id: 'ut99', role: 'OWNER', isDefault: true });

      const result = await organizationService.createOrganization('u1', { name: 'New Logistics Co', setAsDefault: true });

      expect(result.id).toBe('new_t');
      expect(result.role).toBe('OWNER');
      expect(result.isDefault).toBe(true);
      expect(prismaService.userTenant.updateMany).toHaveBeenCalledWith({
        where: { userId: 'u1' },
        data: { isDefault: false },
      });
    });
  });

  describe('getOrganization', () => {
    it('should throw NotFoundException if user is not a member of the tenant or user/tenant deleted', async () => {
      prismaService.userTenant.findFirst.mockResolvedValue(null);

      await expect(
        organizationService.getOrganization('u1', 'non_member_tenant'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException if tenant is soft-deleted or inactive', async () => {
      prismaService.userTenant.findFirst.mockResolvedValue({
        role: 'ADMIN',
        tenant: { id: 't1', status: 'INACTIVE', deletedAt: new Date() },
      });

      await expect(
        organizationService.getOrganization('u1', 't1'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should return organization details for a valid member', async () => {
      const now = new Date();
      prismaService.userTenant.findFirst.mockResolvedValue({
        role: 'ADMIN',
        isDefault: false,
        tenant: {
          id: 't1',
          code: 'logix-hq',
          name: 'LogiX HQ',
          logoUrl: 'https://logo.png',
          status: 'ACTIVE',
          settings: { timezone: 'Asia/Ho_Chi_Minh' },
          legalName: 'Công ty TNHH LogiX',
          taxCode: '0312345678',
          phone: null,
          addressLine: '12 Nguyễn Huệ',
          ward: null,
          district: 'Quận 1',
          province: 'TP. Hồ Chí Minh',
          postalCode: null,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        },
      });

      const org = await organizationService.getOrganization('u1', 't1');
      expect(org.id).toBe('t1');
      expect(org.name).toBe('LogiX HQ');
      expect(org.role).toBe('ADMIN');
      expect(org.settings).toEqual({ timezone: 'Asia/Ho_Chi_Minh' });
      expect(org.legalProfile).toEqual({
        legalName: 'Công ty TNHH LogiX',
        taxCode: '0312345678',
        phone: null,
        addressLine: '12 Nguyễn Huệ',
        ward: null,
        district: 'Quận 1',
        province: 'TP. Hồ Chí Minh',
        postalCode: null,
      });
    });
  });

  describe('updateOrganization', () => {
    it('should throw NotFoundException if user is not a member of the tenant', async () => {
      prismaService.userTenant.findFirst.mockResolvedValue(null);

      await expect(
        organizationService.updateOrganization('u1', 't1', { name: 'New Name' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException if tenant is inactive or soft-deleted', async () => {
      prismaService.userTenant.findFirst.mockResolvedValue({
        role: 'OWNER',
        tenant: { id: 't1', status: 'INACTIVE', deletedAt: new Date() },
      });

      await expect(
        organizationService.updateOrganization('u1', 't1', { name: 'New Name' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException if user is only a MEMBER', async () => {
      prismaService.userTenant.findFirst.mockResolvedValue({
        role: 'MEMBER',
        tenant: { id: 't1', status: 'ACTIVE', deletedAt: null },
      });

      await expect(
        organizationService.updateOrganization('u1', 't1', { name: 'New Name' }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should allow OWNER to update organization name and logo', async () => {
      prismaService.userTenant.findFirst.mockResolvedValue({
        role: 'OWNER',
        isDefault: true,
        tenant: { id: 't1', status: 'ACTIVE', deletedAt: null },
      });
      prismaService.tenant.update.mockResolvedValue({
        id: 't1',
        code: 'logix-hq',
        name: 'Updated Name',
        logoUrl: 'https://new-logo.png',
      });

      const result = await organizationService.updateOrganization('u1', 't1', {
        name: 'Updated Name',
        logoUrl: 'https://new-logo.png',
      });

      expect(result.name).toBe('Updated Name');
      expect(result.logoUrl).toBe('https://new-logo.png');
      expect(result.role).toBe('OWNER');
      expect(prismaService.tenant.update).toHaveBeenCalledWith({
        where: { id: 't1' },
        data: { name: 'Updated Name', logoUrl: 'https://new-logo.png' },
      });
    });

    it('should allow ADMIN to update organization', async () => {
      prismaService.userTenant.findFirst.mockResolvedValue({
        role: 'ADMIN',
        isDefault: false,
        tenant: { id: 't1', status: 'ACTIVE', deletedAt: null },
      });
      prismaService.tenant.update.mockResolvedValue({
        id: 't1',
        code: 'logix-hq',
        name: 'Admin Updated Name',
        logoUrl: null,
      });

      const result = await organizationService.updateOrganization('u1', 't1', {
        name: 'Admin Updated Name',
      });

      expect(result.name).toBe('Admin Updated Name');
      expect(result.role).toBe('ADMIN');
    });

    it('should update and normalize the tenant legal profile', async () => {
      prismaService.userTenant.findFirst.mockResolvedValue({
        role: 'OWNER',
        isDefault: true,
        tenant: { id: 't1', status: 'ACTIVE', deletedAt: null, addressLine: null, province: null },
      });
      prismaService.tenant.update.mockImplementation(({ data }: any) => ({
        id: 't1',
        code: 'logix-hq',
        name: 'LogiX HQ',
        logoUrl: null,
        legalName: null,
        taxCode: null,
        phone: null,
        addressLine: null,
        ward: null,
        district: null,
        province: null,
        postalCode: null,
        ...data,
      }));

      const result = await organizationService.updateOrganization('u1', 't1', {
        legalName: '  Công ty TNHH LogiX  ',
        taxCode: '0312345678',
        phone: '',
        addressLine: '12 Nguyễn Huệ',
        ward: 'Bến Nghé',
        district: 'Quận 1',
        province: 'TP. Hồ Chí Minh',
      });

      expect(prismaService.tenant.update).toHaveBeenCalledWith({
        where: { id: 't1' },
        data: {
          legalName: 'Công ty TNHH LogiX',
          taxCode: '0312345678',
          phone: null,
          addressLine: '12 Nguyễn Huệ',
          ward: 'Bến Nghé',
          district: 'Quận 1',
          province: 'TP. Hồ Chí Minh',
        },
      });
      expect(result.legalProfile).toEqual({
        legalName: 'Công ty TNHH LogiX',
        taxCode: '0312345678',
        phone: null,
        addressLine: '12 Nguyễn Huệ',
        ward: 'Bến Nghé',
        district: 'Quận 1',
        province: 'TP. Hồ Chí Minh',
        postalCode: null,
      });
    });

    it('should reject a legal address line without a province', async () => {
      prismaService.userTenant.findFirst.mockResolvedValue({
        role: 'ADMIN',
        tenant: { id: 't1', status: 'ACTIVE', deletedAt: null, addressLine: null, province: null },
      });

      await expect(
        organizationService.updateOrganization('u1', 't1', { addressLine: '12 Nguyễn Huệ' }),
      ).rejects.toThrow(BadRequestException);
      expect(prismaService.tenant.update).not.toHaveBeenCalled();
    });

    it('should reject clearing only the province of an existing legal address', async () => {
      prismaService.userTenant.findFirst.mockResolvedValue({
        role: 'OWNER',
        tenant: {
          id: 't1',
          status: 'ACTIVE',
          deletedAt: null,
          addressLine: '12 Nguyễn Huệ',
          province: 'TP. Hồ Chí Minh',
        },
      });

      await expect(
        organizationService.updateOrganization('u1', 't1', { province: null }),
      ).rejects.toThrow(BadRequestException);
      expect(prismaService.tenant.update).not.toHaveBeenCalled();
    });

    it('should allow clearing both legal address line and province together', async () => {
      prismaService.userTenant.findFirst.mockResolvedValue({
        role: 'OWNER',
        tenant: {
          id: 't1',
          status: 'ACTIVE',
          deletedAt: null,
          addressLine: '12 Nguyễn Huệ',
          province: 'TP. Hồ Chí Minh',
        },
      });
      prismaService.tenant.update.mockResolvedValue({ id: 't1', addressLine: null, province: null });

      await organizationService.updateOrganization('u1', 't1', { addressLine: '', province: null });

      expect(prismaService.tenant.update).toHaveBeenCalledWith({
        where: { id: 't1' },
        data: { addressLine: null, province: null },
      });
    });
  });

  describe('updateMemberRole', () => {
    it('should throw BadRequestException when caller attempts to update their own role', async () => {
      prismaService.userTenant.findFirst
        .mockResolvedValueOnce({
          id: 'caller_ut',
          userId: 'u1',
          tenantId: 't1',
          role: 'OWNER',
        })
        .mockResolvedValueOnce({
          id: 'target_ut',
          userId: 'u1',
          tenantId: 't1',
          role: 'OWNER',
          user: { id: 'u1', displayName: 'Myself' },
        });

      await expect(
        organizationService.updateMemberRole('u1', 't1', 'target_ut', { role: 'ADMIN' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should allow OWNER to update another member role to ADMIN', async () => {
      prismaService.userTenant.findFirst
        .mockResolvedValueOnce({
          id: 'caller_ut',
          userId: 'u1',
          tenantId: 't1',
          role: 'OWNER',
        })
        .mockResolvedValueOnce({
          id: 'target_ut',
          userId: 'u2',
          tenantId: 't1',
          role: 'MEMBER',
          user: { id: 'u2', displayName: 'Other User' },
        });

      prismaService.userTenant.update.mockResolvedValue({
        id: 'target_ut',
        userId: 'u2',
        role: 'ADMIN',
        user: { id: 'u2', email: 'other@test.com', displayName: 'Other User', avatarUrl: null },
      });

      const res = await organizationService.updateMemberRole('u1', 't1', 'target_ut', { role: 'ADMIN' });
      expect(res.role).toBe('ADMIN');
      expect(res.displayName).toBe('Other User');
    });
  });

  describe('setDefaultTenant', () => {
    it('should throw NotFoundException if user does not belong to target tenant', async () => {
      prismaService.userTenant.findFirst.mockResolvedValue(null);

      await expect(
        organizationService.setDefaultTenant('u1', 'invalid_tenant'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should unset old default and set target tenant as default in a transaction', async () => {
      prismaService.userTenant.findFirst.mockResolvedValue({
        id: 'ut_target',
        userId: 'u1',
        tenantId: 't2',
      });

      const result = await organizationService.setDefaultTenant('u1', 't2');

      expect(result.tenantId).toBe('t2');
      expect(result.isDefault).toBe(true);
      expect(prismaService.$transaction).toHaveBeenCalled();
      expect(prismaService.userTenant.updateMany).toHaveBeenCalledWith({
        where: { userId: 'u1' },
        data: { isDefault: false },
      });
      expect(prismaService.userTenant.update).toHaveBeenCalledWith({
        where: { id: 'ut_target' },
        data: { isDefault: true },
      });
    });
  });

  describe('deleteOrganization', () => {
    it('should throw NotFoundException if user is not found', async () => {
      prismaService.user.findUnique.mockResolvedValue(null);

      await expect(
        organizationService.deleteOrganization('u1', 't1'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException if tenant is not found', async () => {
      prismaService.user.findUnique.mockResolvedValue({ id: 'u1', isSuperAdmin: false });
      prismaService.tenant.findFirst.mockResolvedValue(null);

      await expect(
        organizationService.deleteOrganization('u1', 't1'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException if caller is neither SUPER_ADMIN nor OWNER', async () => {
      prismaService.user.findUnique.mockResolvedValue({ id: 'u1', isSuperAdmin: false });
      prismaService.tenant.findFirst.mockResolvedValue({ id: 't1', code: 'logix', status: 'ACTIVE' });
      prismaService.userTenant.findFirst.mockResolvedValue({
        id: 'ut1',
        userId: 'u1',
        tenantId: 't1',
        role: 'ADMIN',
      });

      await expect(
        organizationService.deleteOrganization('u1', 't1'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw BadRequestException if caller is OWNER but there are still other members in the organization', async () => {
      prismaService.user.findUnique.mockResolvedValue({ id: 'u1', isSuperAdmin: false });
      prismaService.tenant.findFirst.mockResolvedValue({ id: 't1', code: 'logix', status: 'ACTIVE' });
      prismaService.userTenant.findFirst.mockResolvedValue({
        id: 'ut1',
        userId: 'u1',
        tenantId: 't1',
        role: 'OWNER',
      });
      // 1 other member exists
      prismaService.userTenant.count.mockResolvedValue(1);

      await expect(
        organizationService.deleteOrganization('u1', 't1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should allow OWNER to delete organization when no other members exist', async () => {
      prismaService.user.findUnique.mockResolvedValue({ id: 'u1', isSuperAdmin: false });
      prismaService.tenant.findFirst.mockResolvedValue({ id: 't1', code: 'logix', status: 'ACTIVE' });
      prismaService.userTenant.findFirst
        .mockResolvedValueOnce({
          id: 'ut1',
          userId: 'u1',
          tenantId: 't1',
          role: 'OWNER',
        })
        .mockResolvedValueOnce({
          id: 'ut2',
          userId: 'u1',
          tenantId: 't2',
          tenant: { id: 't2', status: 'ACTIVE' },
        });

      // No other members
      prismaService.userTenant.count.mockResolvedValue(0);
      prismaService.userTenant.findMany.mockResolvedValue([{ userId: 'u1' }]);

      const result = await organizationService.deleteOrganization('u1', 't1');

      expect(result.message).toContain('Xóa tổ chức thành công');
      expect(prismaService.$transaction).toHaveBeenCalled();
      expect(prismaService.tenant.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 't1' },
          data: expect.objectContaining({
            status: 'DISABLED',
          }),
        }),
      );
      expect(prismaService.userTenant.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tenantId: 't1', deletedAt: null },
          data: expect.objectContaining({
            status: 'INACTIVE',
            isDefault: false,
          }),
        }),
      );
    });

    it('should allow SUPER_ADMIN to delete organization directly', async () => {
      prismaService.user.findUnique.mockResolvedValue({ id: 'sa1', isSuperAdmin: true });
      prismaService.tenant.findFirst.mockResolvedValue({ id: 't1', code: 'logix', status: 'ACTIVE' });
      prismaService.userTenant.findFirst.mockResolvedValue(null); // Not a member
      prismaService.userTenant.findMany.mockResolvedValue([]);

      const result = await organizationService.deleteOrganization('sa1', 't1');

      expect(result.message).toContain('Xóa tổ chức thành công');
      expect(prismaService.$transaction).toHaveBeenCalled();
      expect(prismaService.tenant.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 't1' },
          data: expect.objectContaining({
            status: 'DISABLED',
          }),
        }),
      );
    });
  });

  describe('leaveOrganization', () => {
    const activeMembership = {
      id: 'ut1',
      userId: 'u1',
      tenantId: 't1',
      role: 'MEMBER',
      isDefault: false,
      tenant: { name: 'Org 1' },
    };

    it('should throw NotFoundException if user is not an active member', async () => {
      prismaService.userTenant.findFirst.mockResolvedValue(null);

      await expect(organizationService.leaveOrganization('u1', 't1')).rejects.toThrow(
        NotFoundException,
      );
      expect(prismaService.$transaction).not.toHaveBeenCalled();
    });

    it('should forbid OWNER from leaving', async () => {
      prismaService.userTenant.findFirst.mockResolvedValue({ ...activeMembership, role: 'OWNER' });

      await expect(organizationService.leaveOrganization('u1', 't1')).rejects.toThrow(
        ForbiddenException,
      );
      expect(prismaService.$transaction).not.toHaveBeenCalled();
    });

    it('should reject leaving when user has no other active organization', async () => {
      prismaService.userTenant.findFirst.mockResolvedValue(activeMembership);
      prismaService.userTenant.count.mockResolvedValue(0);

      await expect(organizationService.leaveOrganization('u1', 't1')).rejects.toThrow(
        BadRequestException,
      );
      expect(prismaService.userTenant.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: 'u1', tenantId: { not: 't1' } }),
        }),
      );
      expect(prismaService.$transaction).not.toHaveBeenCalled();
    });

    it('should reject leaving the default organization', async () => {
      prismaService.userTenant.findFirst.mockResolvedValue({ ...activeMembership, isDefault: true });
      prismaService.userTenant.count.mockResolvedValue(1);

      await expect(organizationService.leaveOrganization('u1', 't1')).rejects.toThrow(
        /mặc định/,
      );
      expect(prismaService.$transaction).not.toHaveBeenCalled();
    });

    it('should soft-delete membership, role grants and revoke sessions on success', async () => {
      prismaService.userTenant.findFirst.mockResolvedValue(activeMembership);
      prismaService.userTenant.count.mockResolvedValue(1);

      const result = await organizationService.leaveOrganization('u1', 't1');

      expect(result).toEqual({
        tenantId: 't1',
        message: expect.stringContaining('Org 1'),
      });
      expect(prismaService.$transaction).toHaveBeenCalled();
      expect(prismaService.userTenant.update).toHaveBeenCalledWith({
        where: { id: 'ut1' },
        data: expect.objectContaining({ status: 'INACTIVE', isDefault: false, deletedAt: expect.any(Date) }),
      });
      expect(prismaService.userRole.updateMany).toHaveBeenCalledWith({
        where: { tenantId: 't1', userId: 'u1', deletedAt: null },
        data: { deletedAt: expect.any(Date) },
      });
      expect(prismaService.session.updateMany).toHaveBeenCalledWith({
        where: { tenantId: 't1', userId: 'u1', revokedAt: null },
        data: expect.objectContaining({ revokeReason: 'LEFT_TENANT', revokedAt: expect.any(Date) }),
      });
    });
  });
});
