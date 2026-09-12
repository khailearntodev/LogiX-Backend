import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../database/prisma.service.js';
import { JwtPayload, AuthenticatedUser } from '../interfaces/jwt-payload.interface.js';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        (request: any) => {
          return request?.cookies?.accessToken || null;
        },
      ]),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET || 'this_is_not_my_secret_i_only_use_env_variable',
    });
  }

  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    const user = await this.prisma.user.findFirst({
      where: {
        id: payload.sub,
        status: 'ACTIVE',
        deletedAt: null,
      },
      include: {
        userTenants: {
          where: {
            tenantId: payload.tenantId,
            status: 'ACTIVE',
            deletedAt: null,
          },
          include: { tenant: true },
        },
      },
    });

    if (!user) {
      throw new UnauthorizedException('Tài khoản không còn hoạt động hoặc không tồn tại');
    }

    const userTenant = user.userTenants[0];
    if (!userTenant || !userTenant.tenant) {
      throw new UnauthorizedException('Bạn không thuộc về tổ chức này hoặc tài khoản trong tổ chức đã bị khóa');
    }

    return {
      id: user.id,
      email: user.email,
      tenantId: userTenant.tenantId,
      displayName: user.displayName,
      phoneNumber: user.phoneNumber,
      avatarUrl: user.avatarUrl,
      tenantName: userTenant.tenant.name,
      tenantLogoUrl: userTenant.tenant.logoUrl,
      role: userTenant.role,
      status: user.status,
    };
  }
}
