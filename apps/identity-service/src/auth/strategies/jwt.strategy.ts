import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../database/prisma.service.js';
import { JwtPayload, AuthenticatedUser } from '../interfaces/jwt-payload.interface.js';
import { RolesService } from '../../iam/services/roles.service.js';
import { SUPER_ADMIN_CONTEXT_ROLE } from '../auth.constants.js';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private readonly prisma: PrismaService,
    configService: ConfigService,
    private readonly rolesService: RolesService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        (request: any) => {
          return request?.cookies?.accessToken || null;
        },
      ]),
      ignoreExpiration: false,
      secretOrKey:
        configService.get<string>('JWT_SECRET') ||
        process.env.JWT_SECRET ||
        'this_is_not_my_secret_i_only_use_env_variable',
    });
  }

  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    if (
      payload.jti !== undefined ||
      !payload.sub ||
      (!payload.tenantId && payload.isSuperAdmin !== true)
    ) {
      throw new UnauthorizedException('Phiên đăng nhập không hợp lệ hoặc đã hết hạn');
    }
    const user = await this.prisma.user.findFirst({
      where: {
        id: payload.sub,
        status: 'ACTIVE',
        deletedAt: null,
      },
      include: {
        userTenants: {
          where: {
            tenantId: payload.tenantId || { in: [] },
            status: 'ACTIVE',
            deletedAt: null,
            tenant: { status: 'ACTIVE', deletedAt: null },
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
      if (user.isSuperAdmin === true) {
        let tenant = null;
        if (payload.tenantId) {
          tenant = await this.prisma.tenant.findFirst({
            where: { id: payload.tenantId, status: 'ACTIVE', deletedAt: null },
          });
          if (!tenant) {
            throw new UnauthorizedException('Bạn không còn truy cập vào tổ chức này');
          }
        }
        return {
          id: user.id,
          email: user.email,
          tenantId: tenant?.id || '',
          displayName: user.displayName,
          phoneNumber: user.phoneNumber,
          avatarUrl: user.avatarUrl,
          tenantName: tenant?.name || 'Platform Admin',
          tenantLogoUrl: tenant?.logoUrl || null,
          role: SUPER_ADMIN_CONTEXT_ROLE,
          status: user.status,
          isSuperAdmin: true,
          permissions: ['*'],
        };
      }
      throw new UnauthorizedException('Bạn không thuộc về tổ chức này hoặc tài khoản trong tổ chức đã bị khóa');
    }

    const { permissions } = await this.rolesService.getEffectivePermissions(
      user.id,
      userTenant.tenantId,
    );

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
      isSuperAdmin: Boolean(user.isSuperAdmin),
      permissions,
    };
  }
}
