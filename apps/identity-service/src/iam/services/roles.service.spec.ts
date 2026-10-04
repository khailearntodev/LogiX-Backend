import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RolesService } from './roles.service.js';
import { PrismaService } from '../../database/prisma.service.js';

describe('RolesService', () => {
  let rolesService: RolesService;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      role: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
      permission: {
        findMany: vi.fn(),
      },
      rolePermission: {
        createMany: vi.fn(),
        deleteMany: vi.fn(),
      },
      user: {
        findFirst: vi.fn(),
      },
      userTenant: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
        update: vi.fn(),
      },
      userRole: {
        findMany: vi.fn(),
        createMany: vi.fn(),
        deleteMany: vi.fn(),
        upsert: vi.fn(),
      },
      $transaction: vi.fn((callback) => callback(prisma)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RolesService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    rolesService = module.get<RolesService>(RolesService);
  });

  describe('getRoles', () => {
    it('should return roles sorted with system roles first and omit SUPER_ADMIN', async () => {
      prisma.role.findMany.mockResolvedValue([
        {
          id: 'role-member',
          code: 'MEMBER',
          name: 'Thành viên',
          description: 'Basic member',
          isSystem: true,
          _count: { userRoles: 5, rolePermissions: 2 },
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: 'role-owner',
          code: 'OWNER',
          name: 'Chủ sở hữu',
          description: 'Owner',
          isSystem: true,
          _count: { userRoles: 1, rolePermissions: 23 },
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: 'role-custom',
          code: 'DISPATCHER',
          name: 'Điều phối viên',
          description: 'Custom dispatcher',
          isSystem: false,
          _count: { userRoles: 2, rolePermissions: 8 },
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: 'role-admin',
          code: 'ADMIN',
          name: 'Quản trị viên',
          description: 'Administrator',
          isSystem: true,
          _count: { userRoles: 2, rolePermissions: 20 },
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const result = await rolesService.getRoles('tenant-1');

      expect(prisma.role.findMany).toHaveBeenCalledWith({
        where: {
          tenantId: 'tenant-1',
          deletedAt: null,
          code: { not: 'SUPER_ADMIN' },
        },
        include: {
          _count: {
            select: {
              userRoles: { where: { deletedAt: null } },
              rolePermissions: { where: { deletedAt: null } },
            },
          },
        },
        orderBy: [
          { isSystem: 'desc' },
          { createdAt: 'asc' },
        ],
      });

      // Verify strict system ordering: OWNER (1) -> ADMIN (2) -> MEMBER (3) -> Custom
      expect(result.map((r) => r.code)).toEqual(['OWNER', 'ADMIN', 'MEMBER', 'DISPATCHER']);
      expect(result.find((r) => r.code === 'SUPER_ADMIN')).toBeUndefined();
    });
  });

  describe('getRoleById', () => {
    it('should throw NotFoundException if role does not exist in tenant', async () => {
      prisma.role.findFirst.mockResolvedValue(null);

      await expect(rolesService.getRoleById('tenant-1', 'non-existent-id')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should return role with permissions and permissionIds', async () => {
      prisma.role.findFirst.mockResolvedValue({
        id: 'role-1',
        code: 'DISPATCHER',
        name: 'Điều phối viên',
        description: 'Test',
        isSystem: false,
        _count: { userRoles: 2 },
        rolePermissions: [
          { permissionId: 'p-1', permission: { id: 'p-1', code: 'transport:trip:read' } },
        ],
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await rolesService.getRoleById('tenant-1', 'role-1');
      expect(result.id).toBe('role-1');
      expect(result.permissionIds).toEqual(['p-1']);
      expect(result.permissions).toHaveLength(1);
    });
  });

  describe('createRole', () => {
    it('should throw BadRequestException if code is in blacklist', async () => {
      await expect(
        rolesService.createRole('tenant-1', {
          name: 'Super Admin',
          code: 'SUPER_ADMIN',
        }),
      ).rejects.toThrow(BadRequestException);

      await expect(
        rolesService.createRole('tenant-1', {
          name: 'Owner',
          code: 'OWNER',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw ConflictException if role code already exists in tenant', async () => {
      prisma.role.findFirst.mockResolvedValue({ id: 'role-1', code: 'ACCOUNTANT' });

      await expect(
        rolesService.createRole('tenant-1', {
          name: 'Kế toán',
          code: 'ACCOUNTANT',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('should create custom role and assign permissions in transaction', async () => {
      prisma.role.findFirst.mockResolvedValue(null);
      prisma.role.create.mockResolvedValue({
        id: 'new-role-id',
        code: 'ACCOUNTANT',
        name: 'Kế toán viên',
        description: 'Phụ trách kế toán',
        isSystem: false,
      });
      prisma.permission.findMany.mockResolvedValue([
        { id: 'perm-1' },
        { id: 'perm-2' },
      ]);

      const result = await rolesService.createRole(
        'tenant-1',
        {
          name: 'Kế toán viên',
          code: 'ACCOUNTANT',
          description: 'Phụ trách kế toán',
          permissionIds: ['perm-1', 'perm-2'],
        },
        'creator-user-id',
      );

      expect(result.id).toBe('new-role-id');
      expect(result.code).toBe('ACCOUNTANT');
      expect(prisma.rolePermission.createMany).toHaveBeenCalledWith({
        data: [
          { tenantId: 'tenant-1', roleId: 'new-role-id', permissionId: 'perm-1', grantedBy: 'creator-user-id' },
          { tenantId: 'tenant-1', roleId: 'new-role-id', permissionId: 'perm-2', grantedBy: 'creator-user-id' },
        ],
      });
    });
  });

  describe('deleteRole', () => {
    it('should throw BadRequestException when trying to delete system roles', async () => {
      prisma.role.findFirst.mockResolvedValue({
        id: 'owner-id',
        code: 'OWNER',
        name: 'Chủ sở hữu',
        isSystem: true,
        _count: { userRoles: 1 },
      });

      await expect(rolesService.deleteRole('tenant-1', 'owner-id')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException if custom role currently has assigned members', async () => {
      prisma.role.findFirst.mockResolvedValue({
        id: 'custom-role-id',
        code: 'DISPATCHER',
        name: 'Điều phối viên',
        isSystem: false,
        _count: { userRoles: 3 },
      });

      await expect(rolesService.deleteRole('tenant-1', 'custom-role-id')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should soft delete role if valid', async () => {
      prisma.role.findFirst.mockResolvedValue({
        id: 'custom-role-id',
        code: 'DISPATCHER',
        name: 'Điều phối viên',
        isSystem: false,
        _count: { userRoles: 0 },
      });
      prisma.role.update.mockResolvedValue({});

      const result = await rolesService.deleteRole('tenant-1', 'custom-role-id');
      expect(result.message).toContain('thành công');
      expect(prisma.role.update).toHaveBeenCalledWith({
        where: { id: 'custom-role-id' },
        data: expect.objectContaining({ deletedAt: expect.any(Date) }),
      });
    });
  });

  describe('updateRolePermissions', () => {
    it('should throw ForbiddenException when attempting to modify OWNER permissions', async () => {
      prisma.role.findFirst.mockResolvedValue({
        id: 'owner-role-id',
        code: 'OWNER',
        isSystem: true,
      });

      await expect(
        rolesService.updateRolePermissions('tenant-1', 'owner-role-id', ['perm-1']),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should replace role permissions in transaction for custom or admin roles', async () => {
      prisma.role.findFirst.mockResolvedValue({
        id: 'custom-role-id',
        code: 'DISPATCHER',
        isSystem: false,
      });
      prisma.permission.findMany.mockResolvedValue([{ id: 'perm-1' }, { id: 'perm-2' }]);

      const result = await rolesService.updateRolePermissions(
        'tenant-1',
        'custom-role-id',
        ['perm-1', 'perm-2'],
        'updater-id',
      );

      expect(prisma.rolePermission.deleteMany).toHaveBeenCalledWith({
        where: { tenantId: 'tenant-1', roleId: 'custom-role-id' },
      });
      expect(prisma.rolePermission.createMany).toHaveBeenCalledWith({
        data: [
          { tenantId: 'tenant-1', roleId: 'custom-role-id', permissionId: 'perm-1', grantedBy: 'updater-id' },
          { tenantId: 'tenant-1', roleId: 'custom-role-id', permissionId: 'perm-2', grantedBy: 'updater-id' },
        ],
      });
      expect(result.grantedCount).toBe(2);
    });
  });

  describe('getEffectivePermissions', () => {
    it('should return wildcard permissions for SUPER_ADMIN regardless of tenant role', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'sa-user-id',
        status: 'ACTIVE',
        isSuperAdmin: true,
      });

      const result = await rolesService.getEffectivePermissions('sa-user-id', 'any-tenant');

      expect(result).toEqual({
        isSuperAdmin: true,
        isOwner: true,
        isAdmin: true,
        roles: ['SUPER_ADMIN'],
        permissions: ['*'],
      });
    });

    it('should return wildcard permissions for OWNER of tenant', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'owner-user-id',
        status: 'ACTIVE',
        isSuperAdmin: false,
      });
      prisma.userTenant.findFirst.mockResolvedValue({
        userId: 'owner-user-id',
        tenantId: 'tenant-1',
        role: 'OWNER',
        status: 'ACTIVE',
      });

      const result = await rolesService.getEffectivePermissions('owner-user-id', 'tenant-1');

      expect(result).toEqual({
        isSuperAdmin: false,
        isOwner: true,
        isAdmin: true,
        roles: ['OWNER'],
        permissions: ['*'],
      });
    });

    it('should return combined unique permissions for standard members with roles', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'member-user-id',
        status: 'ACTIVE',
        isSuperAdmin: false,
      });
      prisma.userTenant.findFirst.mockResolvedValue({
        userId: 'member-user-id',
        tenantId: 'tenant-1',
        role: 'MEMBER',
        status: 'ACTIVE',
      });
      prisma.userRole.findMany.mockResolvedValue([
        {
          role: {
            code: 'DISPATCHER',
            rolePermissions: [
              { permission: { code: 'transport:trip:read' } },
              { permission: { code: 'transport:trip:update' } },
            ],
          },
        },
        {
          role: {
            code: 'VIEWER',
            rolePermissions: [
              { permission: { code: 'transport:trip:read' } }, // Duplicate check
              { permission: { code: 'inventory:warehouse:read' } },
            ],
          },
        },
      ]);

      const result = await rolesService.getEffectivePermissions('member-user-id', 'tenant-1');

      expect(result.isSuperAdmin).toBe(false);
      expect(result.isOwner).toBe(false);
      expect(result.roles).toEqual(['DISPATCHER', 'VIEWER']);
      expect(result.permissions.sort()).toEqual([
        'inventory:warehouse:read',
        'transport:trip:read',
        'transport:trip:update',
      ].sort());
    });
  });

  describe('assignMemberRoles', () => {
    it('should throw ForbiddenException if target member is OWNER', async () => {
      prisma.userTenant.findFirst.mockResolvedValue({
        userId: 'owner-id',
        tenantId: 'tenant-1',
        role: 'OWNER',
        status: 'ACTIVE',
      });

      await expect(
        rolesService.assignMemberRoles('tenant-1', 'owner-id', ['role-1'], 'admin-id'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw BadRequestException if assigner tries to change their own role', async () => {
      prisma.userTenant.findFirst.mockResolvedValue({
        userId: 'user-1',
        tenantId: 'tenant-1',
        role: 'MEMBER',
        status: 'ACTIVE',
      });

      await expect(
        rolesService.assignMemberRoles('tenant-1', 'user-1', ['role-1'], 'user-1'),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
