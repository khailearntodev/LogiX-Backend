import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { OrganizationService } from './organization.service.js';
import { PrismaService } from '../../database/prisma.service.js';

describe('OrganizationService', () => {
  let organizationService: OrganizationService;
  let prismaService: any;

  beforeEach(async () => {
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
        create: vi.fn(),
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        count: vi.fn().mockResolvedValue(0),
      },
      session: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: vi.fn((promises) => Promise.all(promises)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrganizationService,
        { provide: PrismaService, useValue: prismaService },
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
    it('should throw NotFoundException if user is not in tenant or tenant not found', async () => {
      prismaService.userTenant.findFirst.mockResolvedValue(null);

      await expect(
        organizationService.deleteOrganization('u1', 't1'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException if caller is not an OWNER', async () => {
      prismaService.userTenant.findFirst.mockResolvedValue({
        id: 'ut1',
        userId: 'u1',
        tenantId: 't1',
        role: 'ADMIN',
        tenant: { id: 't1', code: 'logix', status: 'ACTIVE' },
      });

      await expect(
        organizationService.deleteOrganization('u1', 't1'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw BadRequestException if there are still other members in the organization', async () => {
      prismaService.userTenant.findFirst.mockResolvedValue({
        id: 'ut1',
        userId: 'u1',
        tenantId: 't1',
        role: 'OWNER',
        tenant: { id: 't1', code: 'logix', status: 'ACTIVE' },
      });
      // 1 other member exists
      prismaService.userTenant.count.mockResolvedValue(1);

      await expect(
        organizationService.deleteOrganization('u1', 't1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should delete organization, anonymize code and disconnect sole owner', async () => {
      prismaService.userTenant.findFirst
        .mockResolvedValueOnce({
          id: 'ut1',
          userId: 'u1',
          tenantId: 't1',
          role: 'OWNER',
          isDefault: true,
          tenant: { id: 't1', code: 'logix', status: 'ACTIVE' },
        })
        .mockResolvedValueOnce({
          id: 'ut2',
          userId: 'u1',
          tenantId: 't2',
          tenant: { id: 't2', status: 'ACTIVE' },
        });

      // No other members
      prismaService.userTenant.count.mockResolvedValue(0);

      const result = await organizationService.deleteOrganization('u1', 't1');

      expect(result.message).toContain('Xóa tổ chức thành công');
      expect(prismaService.$transaction).toHaveBeenCalled();
      expect(prismaService.tenant.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 't1' },
          data: expect.objectContaining({
            status: 'INACTIVE',
          }),
        }),
      );
      expect(prismaService.userTenant.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'ut1' },
          data: expect.objectContaining({
            status: 'INACTIVE',
            isDefault: false,
          }),
        }),
      );
    });
  });
});
