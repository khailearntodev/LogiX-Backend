import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { InvitationsService } from './invitations.service.js';
import { PrismaService } from '../../database/prisma.service.js';
import { TokenService } from '../../auth/services/token.service.js';

describe('InvitationsService', () => {
  let invitationsService: InvitationsService;
  let prisma: any;
  let tokenService: any;

  beforeEach(async () => {
    prisma = {
      userTenant: {
        findFirst: vi.fn(),
        count: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
      role: {
        findMany: vi.fn(),
      },
      userRole: {
        upsert: vi.fn(),
      },
      user: {
        findFirst: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
      tenantInvitation: {
        create: vi.fn(),
        findFirst: vi.fn(),
        findUnique: vi.fn(),
        findMany: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
      },
      $transaction: vi.fn((callback) => callback(prisma)),
    };

    tokenService = {
      generateAccessToken: vi.fn().mockReturnValue('mock_access_token'),
      generateRefreshToken: vi.fn().mockReturnValue('mock_refresh_token'),
      createSession: vi.fn().mockResolvedValue({}),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvitationsService,
        { provide: PrismaService, useValue: prisma },
        { provide: TokenService, useValue: tokenService },
      ],
    }).compile();

    invitationsService = module.get<InvitationsService>(InvitationsService);
  });

  describe('createInvitation', () => {
    it('should throw ConflictException if user is already an active member', async () => {
      prisma.userTenant.findFirst.mockResolvedValue({ id: 'm1', status: 'ACTIVE' });

      await expect(
        invitationsService.createInvitation(
          'tenant-1',
          'inviter-1',
          false,
          'ADMIN',
          { email: 'user@example.com', roleIds: ['r1'] },
        ),
      ).rejects.toThrow(ConflictException);
    });

    it('should throw BadRequestException if any role does not exist in tenant', async () => {
      prisma.userTenant.findFirst.mockResolvedValue(null);
      prisma.role.findMany.mockResolvedValue([{ id: 'r1', code: 'MEMBER' }]);

      await expect(
        invitationsService.createInvitation(
          'tenant-1',
          'inviter-1',
          false,
          'ADMIN',
          { email: 'user@example.com', roleIds: ['r1', 'r2-non-existent'] },
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if trying to invite with SUPER_ADMIN role', async () => {
      prisma.userTenant.findFirst.mockResolvedValue(null);
      prisma.role.findMany.mockResolvedValue([{ id: 'r-sa', code: 'SUPER_ADMIN' }]);

      await expect(
        invitationsService.createInvitation(
          'tenant-1',
          'inviter-1',
          true,
          'OWNER',
          { email: 'user@example.com', roleIds: ['r-sa'] },
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw ForbiddenException if regular ADMIN attempts to invite as OWNER', async () => {
      prisma.userTenant.findFirst.mockResolvedValue(null);
      prisma.role.findMany.mockResolvedValue([{ id: 'r-owner', code: 'OWNER' }]);

      await expect(
        invitationsService.createInvitation(
          'tenant-1',
          'inviter-1',
          false, // not super admin
          'ADMIN', // inviter is only ADMIN
          { email: 'ceo@example.com', roleIds: ['r-owner'] },
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should allow SUPER_ADMIN or tenant OWNER to invite as OWNER', async () => {
      prisma.userTenant.findFirst.mockResolvedValue(null);
      prisma.role.findMany.mockResolvedValue([{ id: 'r-owner', code: 'OWNER', name: 'Chủ sở hữu' }]);
      prisma.tenantInvitation.create.mockResolvedValue({
        id: 'inv-1',
        email: 'ceo@example.com',
        status: 'PENDING',
        expiresAt: new Date(),
        token: 'mock_token',
      });

      const result = await invitationsService.createInvitation(
        'tenant-1',
        'superadmin-id',
        true, // is super admin
        'SUPER_ADMIN',
        { email: 'ceo@example.com', roleIds: ['r-owner'] },
      );

      expect(result.id).toBe('inv-1');
      expect(result.roles[0].code).toBe('OWNER');
      expect(prisma.tenantInvitation.create).toHaveBeenCalled();
    });

    it('should successfully create an invitation with custom roles and revoke older pending ones', async () => {
      prisma.userTenant.findFirst.mockResolvedValue(null);
      prisma.role.findMany.mockResolvedValue([
        { id: 'r-disp', code: 'DISPATCHER', name: 'Điều phối viên' },
      ]);
      prisma.tenantInvitation.create.mockResolvedValue({
        id: 'inv-2',
        email: 'dispatcher@example.com',
        status: 'PENDING',
        expiresAt: new Date(),
        token: 'mock_token_123',
      });

      const result = await invitationsService.createInvitation(
        'tenant-1',
        'inviter-1',
        false,
        'OWNER',
        { email: 'dispatcher@example.com', roleIds: ['r-disp'] },
      );

      expect(prisma.tenantInvitation.updateMany).toHaveBeenCalledWith({
        where: { tenantId: 'tenant-1', email: 'dispatcher@example.com', status: 'PENDING' },
        data: { status: 'REVOKED' },
      });
      expect(result.inviteLink).toContain(`token=${result.token}`);
    });
  });

  describe('revokeInvitation', () => {
    it('should throw NotFoundException if invitation is not found', async () => {
      prisma.tenantInvitation.findFirst.mockResolvedValue(null);

      await expect(
        invitationsService.revokeInvitation('tenant-1', 'inv-not-found'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException if invitation status is not PENDING', async () => {
      prisma.tenantInvitation.findFirst.mockResolvedValue({
        id: 'inv-accepted',
        status: 'ACCEPTED',
      });

      await expect(
        invitationsService.revokeInvitation('tenant-1', 'inv-accepted'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should revoke invitation if PENDING', async () => {
      prisma.tenantInvitation.findFirst.mockResolvedValue({
        id: 'inv-pending',
        status: 'PENDING',
      });
      prisma.tenantInvitation.update.mockResolvedValue({});

      const result = await invitationsService.revokeInvitation('tenant-1', 'inv-pending');
      expect(result.message).toContain('thành công');
      expect(prisma.tenantInvitation.update).toHaveBeenCalledWith({
        where: { id: 'inv-pending' },
        data: { status: 'REVOKED' },
      });
    });
  });

  describe('resendInvitation', () => {
    it('should throw NotFoundException if invitation is not found', async () => {
      prisma.tenantInvitation.findFirst.mockResolvedValue(null);

      await expect(
        invitationsService.resendInvitation('tenant-1', 'inv-not-found'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException if invitation is already ACCEPTED', async () => {
      prisma.tenantInvitation.findFirst.mockResolvedValue({
        id: 'inv-accepted',
        status: 'ACCEPTED',
      });

      await expect(
        invitationsService.resendInvitation('tenant-1', 'inv-accepted'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should generate new token and reset status to PENDING with extended expiration', async () => {
      prisma.tenantInvitation.findFirst.mockResolvedValue({
        id: 'inv-expired',
        email: 'user@example.com',
        status: 'EXPIRED',
      });
      prisma.tenantInvitation.update.mockResolvedValue({
        id: 'inv-expired',
        email: 'user@example.com',
      });

      const result = await invitationsService.resendInvitation('tenant-1', 'inv-expired');

      expect(result.token).toBeDefined();
      expect(result.inviteLink).toContain(`token=${result.token}`);
      expect(result.message).toContain('thành công');
      expect(prisma.tenantInvitation.update).toHaveBeenCalledWith({
        where: { id: 'inv-expired' },
        data: expect.objectContaining({
          status: 'PENDING',
          token: result.token,
        }),
      });
    });
  });

  describe('deleteInvitation', () => {
    it('should throw NotFoundException if invitation is not found', async () => {
      prisma.tenantInvitation.findFirst.mockResolvedValue(null);

      await expect(
        invitationsService.deleteInvitation('tenant-1', 'inv-not-found'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should soft-delete invitation by updating deletedAt', async () => {
      prisma.tenantInvitation.findFirst.mockResolvedValue({
        id: 'inv-to-delete',
      });
      prisma.tenantInvitation.update.mockResolvedValue({});

      const result = await invitationsService.deleteInvitation('tenant-1', 'inv-to-delete');

      expect(result.message).toContain('thành công');
      expect(prisma.tenantInvitation.update).toHaveBeenCalledWith({
        where: { id: 'inv-to-delete' },
        data: expect.objectContaining({
          deletedAt: expect.any(Date),
        }),
      });
    });
  });

  describe('acceptInvitation', () => {
    it('should create new user and assign pre-assigned roles in transaction', async () => {
      const futureDate = new Date(Date.now() + 86400000);
      prisma.tenantInvitation.findFirst.mockResolvedValue({
        id: 'inv-valid',
        tenantId: 'tenant-1',
        email: 'newuser@example.com',
        roleIds: ['r-disp'],
        status: 'PENDING',
        expiresAt: futureDate,
        tenant: { id: 'tenant-1', name: 'LogiX Corp', code: 'LOGIX' },
        inviter: { id: 'inviter-id', displayName: 'Admin' },
      });
      prisma.tenantInvitation.findUnique.mockResolvedValue({
        id: 'inv-valid',
        tenantId: 'tenant-1',
        email: 'newuser@example.com',
        roleIds: ['r-disp'],
        status: 'PENDING',
        inviterId: 'inviter-id',
      });
      prisma.user.findFirst.mockResolvedValue(null); // new user
      prisma.user.create.mockResolvedValue({
        id: 'user-new-id',
        email: 'newuser@example.com',
        displayName: 'New Worker',
        status: 'ACTIVE',
      });
      prisma.role.findMany.mockResolvedValue([
        { id: 'r-disp', code: 'DISPATCHER', name: 'Điều phối viên' },
      ]);
      prisma.userTenant.findFirst.mockResolvedValue(null);
      prisma.userTenant.count.mockResolvedValue(0);
      prisma.userTenant.create.mockResolvedValue({
        id: 'ut-1',
        role: 'DISPATCHER',
      });

      const result = await invitationsService.acceptInvitation(
        'valid_token',
        { password: 'Password123!', displayName: 'New Worker' },
      );

      expect(result.accessToken).toBe('mock_access_token');
      expect(result.assignedRoles[0].code).toBe('DISPATCHER');
      expect(prisma.userRole.upsert).toHaveBeenCalledWith({
        where: {
          tenantId_userId_roleId: {
            tenantId: 'tenant-1',
            userId: 'user-new-id',
            roleId: 'r-disp',
          },
        },
        update: { deletedAt: null },
        create: {
          tenantId: 'tenant-1',
          userId: 'user-new-id',
          roleId: 'r-disp',
          grantedBy: 'inviter-id',
        },
      });
      expect(prisma.tenantInvitation.update).toHaveBeenCalledWith({
        where: { id: 'inv-valid' },
        data: expect.objectContaining({ status: 'ACCEPTED' }),
      });
    });
  });
});
