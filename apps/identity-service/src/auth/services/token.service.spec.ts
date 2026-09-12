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
});
