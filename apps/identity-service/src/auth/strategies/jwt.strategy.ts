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
      if (user.isSuperAdmin) {
        let tenant = null;
        if (payload.tenantId) {
          tenant = await this.prisma.tenant.findFirst({
            where: { id: payload.tenantId, status: 'ACTIVE', deletedAt: null },
          });
        }
        return {
          id: user.id,
          email: user.email,
          tenantId: tenant?.id || payload.tenantId || '',
          displayName: user.displayName,
          phoneNumber: user.phoneNumber,
          avatarUrl: user.avatarUrl,
          tenantName: tenant?.name || 'Platform Admin',
          tenantLogoUrl: tenant?.logoUrl || null,
          role: 'OWNER',
          status: user.status,
          isSuperAdmin: true,
          permissions: ['*'],
        };
      }
      throw new UnauthorizedException('Bạn không thuộc về tổ chức này hoặc tài khoản trong tổ chức đã bị khóa');
    }

    let permissions: string[] = [];
    if (user.isSuperAdmin || userTenant.role === 'OWNER') {
      permissions = ['*'];
    } else {
      const userRoles = await this.prisma.userRole.findMany({
        where: {
          userId: user.id,
          tenantId: userTenant.tenantId,
          deletedAt: null,
        },
        include: {
          role: {
            include: {
              rolePermissions: {
                where: { deletedAt: null },
                include: { permission: true },
              },
            },
          },
        },
      });

      const permSet = new Set<string>();
      for (const ur of userRoles) {
        for (const rp of ur.role.rolePermissions) {
          if (rp.permission && !rp.permission.deletedAt) {
            permSet.add(rp.permission.code);
          }
        }
      }
      permissions = Array.from(permSet);
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
      isSuperAdmin: Boolean(user.isSuperAdmin),
      permissions,
    };
  }
}
