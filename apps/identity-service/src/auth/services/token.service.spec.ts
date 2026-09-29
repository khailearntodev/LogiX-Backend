import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { TokenService } from './token.service.js';
import { PrismaService } from '../../database/prisma.service.js';

describe('TokenService', () => {
  let tokenService: TokenService;
  let jwtService: any;
  let prismaService: any;

  beforeEach(async () => {
    jwtService = {
      sign: vi.fn().mockReturnValue('signed_jwt_token'),
      verify: vi.fn(),
    };

    prismaService = {
      session: {
        create: vi.fn().mockResolvedValue({ id: 's1' }),
        findFirst: vi.fn(),
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      user: {
        findFirst: vi.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TokenService,
        { provide: JwtService, useValue: jwtService },
        { provide: PrismaService, useValue: prismaService },
      ],
    }).compile();

    tokenService = module.get<TokenService>(TokenService);
  });

  describe('generateAccessToken & generateRefreshToken', () => {
    it('should generate signed tokens', () => {
      const payload = { sub: 'u1', email: 'a@b.com', tenantId: 't1' };
      const token = tokenService.generateAccessToken(payload);
      expect(token).toBe('signed_jwt_token');
      expect(jwtService.sign).toHaveBeenCalledWith(payload, expect.anything());
    });
  });

  describe('refreshTokens', () => {
    it('should throw UnauthorizedException if token verification fails', async () => {
      jwtService.verify.mockImplementation(() => {
        throw new Error('jwt expired');
      });

      await expect(tokenService.refreshTokens('invalid_token')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should throw UnauthorizedException if session is invalid or revoked', async () => {
      jwtService.verify.mockReturnValue({ sub: 'u1', tenantId: 't1' });
      prismaService.session.findFirst.mockResolvedValue(null);

      await expect(tokenService.refreshTokens('valid_token')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should rotate tokens and create new session when refresh token is valid', async () => {
      jwtService.verify.mockReturnValue({ sub: 'u1', tenantId: 't1' });
      prismaService.session.findFirst.mockResolvedValue({
        id: 's1',
        tenantId: 't1',
        expiresAt: new Date(Date.now() + 100000),
        userAgent: 'Chrome',
      });
      prismaService.user.findFirst.mockResolvedValue({
        id: 'u1',
        email: 'user@logix.vn',
        displayName: 'LogiX User',
        status: 'ACTIVE',
        userTenants: [
          {
            tenantId: 't1',
            role: 'OWNER',
            tenant: { id: 't1', name: 'LogiX Corp', logoUrl: null },
          },
        ],
      });

      const result = await tokenService.refreshTokens('valid_token');

      expect(result.accessToken).toBe('signed_jwt_token');
      expect(result.refreshToken).toBe('signed_jwt_token');
      expect(prismaService.session.update).toHaveBeenCalledWith({
        where: { id: 's1' },
        data: { revokedAt: expect.any(Date), revokeReason: 'ROTATED' },
      });
    });
  });

  describe('parseUserAgent', () => {
    it('should parse Windows and Chrome user agent correctly', () => {
      const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
      const result = tokenService.parseUserAgent(ua);
      expect(result.os).toBe('Windows');
      expect(result.browser).toBe('Google Chrome');
      expect(result.deviceType).toBe('DESKTOP');
    });

    it('should parse iPhone mobile user agent correctly', () => {
      const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
      const result = tokenService.parseUserAgent(ua);
      expect(result.os).toBe('iOS');
      expect(result.browser).toBe('Safari');
      expect(result.deviceType).toBe('MOBILE');
    });
  });

  describe('getActiveSessions', () => {
    it('should return parsed session list with isCurrent marked', async () => {
      prismaService.session.findMany = vi.fn().mockResolvedValue([
        {
          id: 's1',
          refreshTokenHash: tokenService.hashToken('my_current_token'),
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0.0.0',
          ipHash: 'some_hash',
          issuedAt: new Date(),
          updatedAt: new Date(),
          expiresAt: new Date(Date.now() + 100000),
        },
      ]);

      const sessions = await tokenService.getActiveSessions('u1', 'my_current_token');
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe('s1');
      expect(sessions[0].isCurrent).toBe(true);
      expect(sessions[0].browser).toBe('Google Chrome');
      expect(sessions[0].os).toBe('Windows');
    });
  });

  describe('revokeSession', () => {
    it('should throw UnauthorizedException if session not found', async () => {
      prismaService.session.findFirst.mockResolvedValue(null);

      await expect(tokenService.revokeSession('u1', 'invalid_session_id')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should revoke target session if valid', async () => {
      prismaService.session.findFirst.mockResolvedValue({ id: 's2', userId: 'u1' });
      prismaService.session.update.mockResolvedValue({});

      const result = await tokenService.revokeSession('u1', 's2');
      expect(result.message).toBe('Đăng xuất phiên làm việc từ xa thành công');
      expect(prismaService.session.update).toHaveBeenCalledWith({
        where: { id: 's2' },
        data: {
          revokedAt: expect.any(Date),
          revokeReason: 'USER_REMOTE_REVOKE',
        },
      });
    });
  });

  describe('revokeOtherSessions', () => {
    it('should revoke all other active sessions for user', async () => {
      prismaService.session.updateMany.mockResolvedValue({ count: 3 });

      const result = await tokenService.revokeOtherSessions('u1', 'current_active_token');
      expect(result.count).toBe(3);
      expect(prismaService.session.updateMany).toHaveBeenCalledWith({
        where: {
          userId: 'u1',
          refreshTokenHash: { not: tokenService.hashToken('current_active_token') },
          revokedAt: null,
        },
        data: {
          revokedAt: expect.any(Date),
          revokeReason: 'REVOKE_OTHERS',
        },
      });
    });
  });
});

