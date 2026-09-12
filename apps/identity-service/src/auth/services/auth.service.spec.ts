import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException, ConflictException, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service.js';
import { TokenService } from './token.service.js';
import { PrismaService } from '../../database/prisma.service.js';

describe('AuthService', () => {
  let authService: AuthService;
  let prismaService: any;
  let tokenService: any;

  beforeEach(async () => {
    prismaService = {
      user: {
        findFirst: vi.fn(),
        findUnique: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
      tenant: {
        findUnique: vi.fn(),
        findFirst: vi.fn(),
        create: vi.fn(),
      },
      userTenant: {
        findFirst: vi.fn(),
        create: vi.fn(),
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        count: vi.fn().mockResolvedValue(0),
      },
      passwordResetToken: {
        create: vi.fn(),
        findFirst: vi.fn(),
        update: vi.fn(),
      },
      $transaction: vi.fn((promises) => Promise.all(promises)),
    };

    tokenService = {
      generateAccessToken: vi.fn().mockReturnValue('mock_access_token'),
      generateRefreshToken: vi.fn().mockReturnValue('mock_refresh_token'),
      createSession: vi.fn().mockResolvedValue({ id: 'session_1' }),
      hashToken: vi.fn((t) => `hashed_${t}`),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prismaService },
        { provide: TokenService, useValue: tokenService },
      ],
    }).compile();

    authService = module.get<AuthService>(AuthService);
  });

  describe('login', () => {
    it('should throw UnauthorizedException if user not found', async () => {
      prismaService.user.findFirst.mockResolvedValue(null);

      await expect(
        authService.login({ email: 'wrong@logix.vn', password: 'password123' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException if password does not match', async () => {
      const hashedPassword = await bcrypt.hash('correct_password', 10);
      prismaService.user.findFirst.mockResolvedValue({
        id: 'u1',
        email: 'test@logix.vn',
        passwordHash: hashedPassword,
        status: 'ACTIVE',
        userTenants: [
          {
            tenantId: 't1',
            role: 'OWNER',
            isDefault: true,
            tenant: { id: 't1', code: 'logix', name: 'LogiX Corp', logoUrl: null },
          },
        ],
      });

      await expect(
        authService.login({ email: 'test@logix.vn', password: 'wrong_password' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should return tokens, activeTenant and tenants list on successful login', async () => {
      const hashedPassword = await bcrypt.hash('password123', 10);
      prismaService.user.findFirst.mockResolvedValue({
        id: 'u1',
        email: 'test@logix.vn',
        passwordHash: hashedPassword,
        displayName: 'Test User',
        status: 'ACTIVE',
        userTenants: [
          {
            tenantId: 't1',
            role: 'OWNER',
            isDefault: true,
            tenant: { id: 't1', code: 'logix', name: 'LogiX Corp', logoUrl: null },
          },
        ],
      });
      prismaService.user.update.mockResolvedValue({});

      const result = await authService.login({
        email: 'test@logix.vn',
        password: 'password123',
      });

      expect(result.accessToken).toBe('mock_access_token');
      expect(result.refreshToken).toBe('mock_refresh_token');
      expect(result.user.email).toBe('test@logix.vn');
      expect(result.activeTenant.id).toBe('t1');
      expect(result.tenants).toHaveLength(1);
      expect(tokenService.createSession).toHaveBeenCalled();
    });
  });

  describe('register', () => {
    it('should throw ConflictException if existing user tries to register without invite link', async () => {
      prismaService.user.findFirst.mockResolvedValue({ id: 'existing_u', email: 'existing@logix.vn' });

      await expect(
        authService.register({
          email: 'existing@logix.vn',
          password: 'password123',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('should throw ConflictException if user is already a member of tenant when joining via invite', async () => {
      const hashedPassword = await bcrypt.hash('password123', 10);
      prismaService.user.findFirst.mockResolvedValue({ id: 'existing_u', email: 'existing@logix.vn', passwordHash: hashedPassword });
      prismaService.tenant.findUnique.mockResolvedValue({ id: 't1', code: 'logix', name: 'LogiX Corp' });
      prismaService.userTenant.findFirst.mockResolvedValue({ id: 'ut_1' });

      await expect(
        authService.register({
          email: 'existing@logix.vn',
          password: 'password123',
          tenantId: 't1',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('should create new user, tenant and userTenant', async () => {
      prismaService.user.findFirst.mockResolvedValue(null);
      prismaService.tenant.findFirst.mockResolvedValue(null);
      prismaService.tenant.create.mockResolvedValue({
        id: 't1',
        code: 'tenant-123',
        name: 'New User Organization',
      });
      prismaService.user.create.mockResolvedValue({
        id: 'new_u1',
        email: 'new@logix.vn',
        displayName: 'New User',
      });
      prismaService.userTenant.findFirst.mockResolvedValue(null);
      prismaService.userTenant.create.mockResolvedValue({});

      const result = await authService.register({
        email: 'new@logix.vn',
        password: 'password123',
        displayName: 'New User',
        tenantName: 'New User Organization',
      });

      expect(result.id).toBe('new_u1');
      expect(result.email).toBe('new@logix.vn');
      expect(prismaService.user.create).toHaveBeenCalled();
      expect(prismaService.userTenant.create).toHaveBeenCalled();
    });
  });

  describe('createOrganization', () => {
    it('should create organization for logged in user', async () => {
      prismaService.user.findUnique.mockResolvedValue({ id: 'u1', status: 'ACTIVE' });
      prismaService.tenant.create.mockResolvedValue({ id: 'new_t', code: 'tenant-99', name: 'New Logistics Co' });
      prismaService.userTenant.create.mockResolvedValue({ id: 'ut99', role: 'OWNER', isDefault: true });

      const result = await authService.createOrganization('u1', { name: 'New Logistics Co', setAsDefault: true });

      expect(result.id).toBe('new_t');
      expect(result.role).toBe('OWNER');
      expect(result.isDefault).toBe(true);
    });
  });

  describe('updateProfile', () => {
    it('should update user profile info', async () => {
      prismaService.user.findUnique.mockResolvedValue({ id: 'u1', status: 'ACTIVE' });
      prismaService.user.update.mockResolvedValue({
        id: 'u1',
        email: 'user@logix.vn',
        displayName: 'New Name',
        phoneNumber: '0901234567',
        avatarUrl: 'https://cdn.logix.vn/avatar.png',
      });

      const result = await authService.updateProfile('u1', {
        displayName: 'New Name',
        phoneNumber: '0901234567',
      });

      expect(result.displayName).toBe('New Name');
      expect(result.phoneNumber).toBe('0901234567');
    });
  });

  describe('switchTenant', () => {
    it('should throw UnauthorizedException if user does not belong to target tenant', async () => {
      prismaService.userTenant.findFirst.mockResolvedValue(null);

      await expect(
        authService.switchTenant('u1', { tenantId: 'invalid_tenant' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should switch tenant and return new tokens', async () => {
      prismaService.userTenant.findFirst.mockResolvedValue({
        id: 'ut1',
        userId: 'u1',
        tenantId: 't2',
        role: 'ADMIN',
        user: { id: 'u1', email: 'user@logix.vn', status: 'ACTIVE' },
        tenant: { id: 't2', code: 'branch2', name: 'Branch 2', logoUrl: null },
      });

      const result = await authService.switchTenant('u1', { tenantId: 't2' });

      expect(result.accessToken).toBe('mock_access_token');
      expect(result.activeTenant.id).toBe('t2');
      expect(result.activeTenant.role).toBe('ADMIN');
    });
  });

  describe('getProfile', () => {
    it('should throw NotFoundException if user does not exist', async () => {
      prismaService.user.findUnique.mockResolvedValue(null);

      await expect(authService.getProfile('invalid_id')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should return user profile and active tenant', async () => {
      prismaService.user.findUnique.mockResolvedValue({
        id: 'u1',
        email: 'user@logix.vn',
        displayName: 'LogiX User',
        status: 'ACTIVE',
        userTenants: [
          {
            tenantId: 't1',
            role: 'OWNER',
            isDefault: true,
            tenant: { id: 't1', code: 'logix', name: 'LogiX Corp', logoUrl: null },
          },
        ],
      });

      const profile = await authService.getProfile('u1', 't1');
      expect(profile.id).toBe('u1');
      expect(profile.email).toBe('user@logix.vn');
      expect(profile.activeTenant?.name).toBe('LogiX Corp');
    });
  });
});
