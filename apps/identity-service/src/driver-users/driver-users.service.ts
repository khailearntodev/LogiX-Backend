import { Injectable, NotFoundException } from '@nestjs/common';
import { TRANSPORT_PERMISSIONS } from '@logix/auth';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import {
  DRIVER_USER_PAGE_SIZE,
  type DriverUsersQuery,
} from './driver-users.dto.js';

const ACTIVE = 'ACTIVE';
const DRIVER_CAPABILITIES = [
  TRANSPORT_PERMISSIONS.DRIVER_READ,
  TRANSPORT_PERMISSIONS.DRIVER_UPDATE,
] as const;
const userSelect = {
  id: true,
  displayName: true,
  email: true,
  status: true,
} as const;

export function eligibleDriverUserWhere(
  tenantId: string,
): Prisma.UserWhereInput {
  const member: Prisma.UserWhereInput = {
    status: ACTIVE,
    deletedAt: null,
    userTenants: {
      some: {
        tenantId,
        status: ACTIVE,
        deletedAt: null,
        tenant: { status: ACTIVE, deletedAt: null },
      },
    },
  };
  const roleWith = (code: string): Prisma.UserWhereInput => ({
    userRoles: {
      some: {
        tenantId,
        deletedAt: null,
        role: {
          tenantId,
          deletedAt: null,
          rolePermissions: {
            some: {
              tenantId,
              deletedAt: null,
              permission: { code, deletedAt: null },
            },
          },
        },
      },
    },
  });
  return {
    ...member,
    OR: [
      { isSuperAdmin: true },
      {
        userTenants: {
          some: { tenantId, status: ACTIVE, deletedAt: null, role: 'OWNER' },
        },
      },
      {
        userRoles: {
          some: {
            tenantId,
            deletedAt: null,
            role: { tenantId, code: 'OWNER', deletedAt: null },
          },
        },
      },
      roleWith('*'),
      { AND: DRIVER_CAPABILITIES.map(roleWith) },
    ],
  };
}

@Injectable()
export class DriverUsersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(tenantId: string, query: DriverUsersQuery) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DRIVER_USER_PAGE_SIZE;
    const where: Prisma.UserWhereInput = {
      AND: [
        eligibleDriverUserWhere(tenantId),
        ...(query.q
          ? [
              {
                OR: [
                  {
                    displayName: {
                      contains: query.q,
                      mode: 'insensitive' as const,
                    },
                  },
                  {
                    email: { contains: query.q, mode: 'insensitive' as const },
                  },
                ],
              },
            ]
          : []),
      ],
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        select: userSelect,
        orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.user.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  async eligible(tenantId: string, id: string) {
    const user = await this.prisma.user.findFirst({
      where: { AND: [eligibleDriverUserWhere(tenantId), { id }] },
      select: userSelect,
    });
    if (!user)
      throw new NotFoundException(
        'Không tìm thấy thành viên đang hoạt động có đủ quyền tài xế',
      );
    return user;
  }

  async resolve(tenantId: string, userIds: string[]) {
    // Historical profile display must still resolve suspended users/memberships.
    const items = await this.prisma.user.findMany({
      where: { id: { in: userIds }, userTenants: { some: { tenantId } } },
      select: userSelect,
    });
    if (new Set(items.map((item) => item.id)).size !== new Set(userIds).size)
      throw new NotFoundException(
        'Không tìm thấy người dùng liên kết trong tổ chức',
      );
    return { items };
  }
}
