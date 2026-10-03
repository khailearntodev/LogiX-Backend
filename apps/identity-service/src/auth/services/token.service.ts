import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
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
          where: {
            tenantId: session.tenantId,
            status: 'ACTIVE',
            deletedAt: null,
            tenant: {
              status: 'ACTIVE',
              deletedAt: null,
            },
          },
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
      isSuperAdmin: Boolean(user.isSuperAdmin),
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
        isSuperAdmin: Boolean(user.isSuperAdmin),
      },
    };
  }

  parseUserAgent(uaString?: string | null): {
    browser: string;
    os: string;
    deviceType: 'DESKTOP' | 'MOBILE' | 'TABLET' | 'UNKNOWN';
  } {
    if (!uaString) {
      return { browser: 'Unknown Browser', os: 'Unknown OS', deviceType: 'UNKNOWN' };
    }

    const ua = uaString.toLowerCase();

    // Determine device type
    let deviceType: 'DESKTOP' | 'MOBILE' | 'TABLET' | 'UNKNOWN' = 'DESKTOP';
    if (ua.includes('tablet') || ua.includes('ipad')) {
      deviceType = 'TABLET';
    } else if (ua.includes('mobile') || ua.includes('iphone') || ua.includes('android')) {
      deviceType = 'MOBILE';
    }

    // Determine OS
    let os = 'Unknown OS';
    if (ua.includes('iphone') || ua.includes('ipad') || ua.includes('ipod')) {
      os = 'iOS';
    } else if (ua.includes('android')) {
      os = 'Android';
    } else if (ua.includes('windows nt 10.0') || ua.includes('windows nt 11.0') || ua.includes('windows')) {
      os = 'Windows';
    } else if (ua.includes('macintosh') || ua.includes('mac os x')) {
      os = 'macOS';
    } else if (ua.includes('linux')) {
      os = 'Linux';
    }

    // Determine Browser
    let browser = 'Unknown Browser';
    if (ua.includes('edg/')) {
      browser = 'Microsoft Edge';
    } else if (ua.includes('chrome/') && !ua.includes('chromium')) {
      browser = 'Google Chrome';
    } else if (ua.includes('safari/') && !ua.includes('chrome')) {
      browser = 'Safari';
    } else if (ua.includes('firefox/')) {
      browser = 'Mozilla Firefox';
    } else if (ua.includes('opr/') || ua.includes('opera/')) {
      browser = 'Opera';
    }

    return { browser, os, deviceType };
  }

  async getActiveSessions(userId: string, currentRefreshToken?: string) {
    const currentTokenHash = currentRefreshToken ? this.hashToken(currentRefreshToken) : null;

    const sessions = await this.prisma.session.findMany({
      where: {
        userId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { updatedAt: 'desc' },
    });

    return sessions.map((session) => {
      const parsedUA = this.parseUserAgent(session.userAgent);
      return {
        id: session.id,
        device: `${parsedUA.os} • ${parsedUA.browser}`,
        browser: parsedUA.browser,
        os: parsedUA.os,
        deviceType: parsedUA.deviceType,
        ipAddress: session.ipHash ? 'Đã được mã hóa an toàn' : 'Không xác định',
        isCurrent: currentTokenHash ? session.refreshTokenHash === currentTokenHash : false,
        issuedAt: session.issuedAt,
        lastActiveAt: session.updatedAt,
        expiresAt: session.expiresAt,
      };
    });
  }

  async revokeSession(userId: string, sessionId: string) {
    const session = await this.prisma.session.findFirst({
      where: {
        id: sessionId,
        userId,
        revokedAt: null,
      },
    });

    if (!session) {
      throw new UnauthorizedException('Phiên đăng nhập không tồn tại hoặc đã bị thu hồi');
    }

    await this.prisma.session.update({
      where: { id: sessionId },
      data: {
        revokedAt: new Date(),
        revokeReason: 'USER_REMOTE_REVOKE',
      },
    });

    return { message: 'Đăng xuất phiên làm việc từ xa thành công' };
  }

  async revokeOtherSessions(userId: string, currentRefreshToken?: string) {
    if (!currentRefreshToken) {
      throw new UnauthorizedException('Không thể xác định phiên làm việc hiện tại');
    }

    const currentTokenHash = this.hashToken(currentRefreshToken);

    const result = await this.prisma.session.updateMany({
      where: {
        userId,
        refreshTokenHash: { not: currentTokenHash },
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
        revokeReason: 'REVOKE_OTHERS',
      },
    });

    return {
      message: `Đã đăng xuất thành công khỏi ${result.count} thiết bị khác`,
      count: result.count,
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
