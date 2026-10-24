import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import {
  ADMIN_ACTIVE_MEMBERSHIP_STATUS,
  ADMIN_MAX_OFFSET,
  AdminOrganizationStatus,
} from '../admin.constants.js';
import {
  ListAdminQueryDto,
  ListOrganizationsQueryDto,
  ListUsersQueryDto,
} from '../dto/list-admin-query.dto.js';

@Injectable()
export class AdminQueryService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async listOrganizations(query: ListOrganizationsQueryDto) {
    const skip = this.offset(query);
    const where: Prisma.TenantWhereInput = {
      deletedAt: null,
      ...(query.status ? { status: query.status } : {}),
      ...(query.q
        ? {
            OR: [
              { code: { contains: query.q, mode: 'insensitive' } },
              { name: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [organizations, total] = await this.prisma.$transaction(
      [
        this.prisma.tenant.findMany({
          where,
          skip,
          take: query.pageSize,
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          select: {
            id: true,
            code: true,
            name: true,
            status: true,
            logoUrl: true,
            createdAt: true,
            updatedAt: true,
            userTenants: {
              where: {
                role: 'OWNER',
                status: ADMIN_ACTIVE_MEMBERSHIP_STATUS,
                deletedAt: null,
                user: { deletedAt: null },
              },
              orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
              take: 1,
              select: {
                user: {
                  select: { displayName: true, email: true, avatarUrl: true },
                },
              },
            },
          },
        }),
        this.prisma.tenant.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    const items = organizations.map(({ userTenants, ...organization }) => ({
      ...organization,
      owner: userTenants[0]?.user ?? null,
    }));
    return { items, page: query.page, pageSize: query.pageSize, total };
  }

  async listUsers(query: ListUsersQueryDto) {
    const skip = this.offset(query);
    const where: Prisma.UserWhereInput = {
      deletedAt: null,
      ...(query.status ? { status: query.status } : {}),
      ...(query.q
        ? {
            OR: [
              { email: { contains: query.q, mode: 'insensitive' } },
              { displayName: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [users, total] = await this.prisma.$transaction(
      [
        this.prisma.user.findMany({
          where,
          skip,
          take: query.pageSize,
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          select: {
            id: true,
            email: true,
            displayName: true,
            phoneNumber: true,
            avatarUrl: true,
            status: true,
            isSuperAdmin: true,
            lastLoginAt: true,
            createdAt: true,
            updatedAt: true,
            _count: {
              select: {
                userTenants: {
                  where: {
                    status: ADMIN_ACTIVE_MEMBERSHIP_STATUS,
                    deletedAt: null,
                    tenant: {
                      status: AdminOrganizationStatus.ACTIVE,
                      deletedAt: null,
                    },
                  },
                },
              },
            },
          },
        }),
        this.prisma.user.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    const items = users.map(({ _count, ...user }) => ({
      ...user,
      tenantCount: _count.userTenants,
    }));
    return { items, page: query.page, pageSize: query.pageSize, total };
  }

  private offset({ page, pageSize }: ListAdminQueryDto): number {
    const skip = (page - 1) * pageSize;
    if (!Number.isSafeInteger(skip) || skip < 0 || skip > ADMIN_MAX_OFFSET) {
      throw new BadRequestException(
        'Pagination offset exceeds the supported range',
      );
    }
    return skip;
  }
}
