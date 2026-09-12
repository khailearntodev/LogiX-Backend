import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import crypto from 'crypto';
import { PrismaService } from '../../database/prisma.service.js';
import { JwtPayload } from '../interfaces/jwt-payload.interface.js';

@Injectable()
export class TokenService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  generateAccessToken(payload: JwtPayload): string {
    return this.jwtService.sign(payload as Record<string, any>, {
      expiresIn: (process.env.JWT_EXPIRES_IN || '15m') as any,
    });
  }

  generateRefreshToken(payload: JwtPayload): string {
    return this.jwtService.sign(payload as Record<string, any>, {
      expiresIn: (process.env.JWT_REFRESH_EXPIRES_IN || '7d') as any,
    });
  }

  hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  async createSession(params: {
    userId: string;
    tenantId: string;
    refreshToken: string;
    userAgent?: string;
    ipAddress?: string;
    deviceId?: string;
  }) {
    const refreshTokenHash = this.hashToken(params.refreshToken);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 ngày

    return this.prisma.session.create({
      data: {
        userId: params.userId,
        tenantId: params.tenantId,
        refreshTokenHash,
        userAgent: params.userAgent || null,
        ipHash: params.ipAddress ? this.hashToken(params.ipAddress) : null,
        deviceId: params.deviceId || null,
        expiresAt,
      },
    });
  }

  async refreshTokens(refreshToken: string) {
    let payload: JwtPayload;
    try {
      payload = this.jwtService.verify<JwtPayload>(refreshToken);
    } catch {
      throw new UnauthorizedException('Refresh token không hợp lệ hoặc đã hết hạn');
    }

    const tokenHash = this.hashToken(refreshToken);
    const session = await this.prisma.session.findFirst({
      where: {
        refreshTokenHash: tokenHash,
        userId: payload.sub,
        revokedAt: null,
      },
    });

    if (!session || session.expiresAt < new Date()) {
      throw new UnauthorizedException('Phiên làm việc đã hết hạn hoặc bị thu hồi');
    }

    const user = await this.prisma.user.findFirst({
      where: { id: payload.sub, status: 'ACTIVE', deletedAt: null },
      include: {
        userTenants: {
          where: { tenantId: session.tenantId, status: 'ACTIVE', deletedAt: null },
          include: { tenant: true },
        },
      },
    });

    if (!user) {
      throw new UnauthorizedException('Tài khoản không hoạt động');
    }

    const userTenant = user.userTenants[0];
    if (!userTenant || !userTenant.tenant) {
      throw new UnauthorizedException('Bạn không còn truy cập vào tổ chức này');
    }

    // Revoke old session
    await this.prisma.session.update({
      where: { id: session.id },
      data: { revokedAt: new Date(), revokeReason: 'ROTATED' },
    });

    // Create new tokens and session
    const newPayload: JwtPayload = {
      sub: user.id,
      email: user.email,
      tenantId: userTenant.tenantId,
    };

    const newAccessToken = this.generateAccessToken(newPayload);
    const newRefreshToken = this.generateRefreshToken(newPayload);

    await this.createSession({
      userId: user.id,
      tenantId: userTenant.tenantId,
      refreshToken: newRefreshToken,
      userAgent: session.userAgent || undefined,
      deviceId: session.deviceId || undefined,
    });

    return {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        phoneNumber: user.phoneNumber,
        avatarUrl: user.avatarUrl,
        tenantId: userTenant.tenantId,
        tenantName: userTenant.tenant.name,
        tenantLogoUrl: userTenant.tenant.logoUrl,
        role: userTenant.role,
      },
    };
  }

  async revokeSessionByToken(refreshToken: string) {
    try {
      const tokenHash = this.hashToken(refreshToken);
      await this.prisma.session.updateMany({
        where: { refreshTokenHash: tokenHash, revokedAt: null },
        data: { revokedAt: new Date(), revokeReason: 'LOGOUT' },
      });
    } catch {
      // Ignore if session not found
    }
  }
}
