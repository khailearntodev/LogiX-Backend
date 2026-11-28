import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../database/prisma.service.js';
import {
  DEFAULT_RECIPIENT_RESOLVE_LIMIT,
  MAX_RECIPIENT_RESOLVE_LIMIT,
  type ResolveNotificationRecipientsDto,
} from './notification-recipients.dto.js';

export interface ResolveNotificationRecipientsResult {
  userIds: string[];
  nextCursor: string | null;
  hasMore: boolean;
}

@Injectable()
export class NotificationRecipientsService {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(
    tenantId: string,
    dto: ResolveNotificationRecipientsDto,
  ): Promise<ResolveNotificationRecipientsResult> {
    const limit = Math.min(
      Math.max(dto.limit ?? DEFAULT_RECIPIENT_RESOLVE_LIMIT, 1),
      MAX_RECIPIENT_RESOLVE_LIMIT,
    );
    const snapshotDate = dto.snapshotAt ? new Date(dto.snapshotAt) : undefined;
    const { audience } = dto;
    const andConditions: Prisma.UserWhereInput[] = [];

    if (dto.cursor) {
      andConditions.push({ id: { gt: dto.cursor } });
    }

    if (audience.kind === 'USERS') {
      const uniqueUserIds = [...new Set(audience.userIds ?? [])];
      if (uniqueUserIds.length === 0) {
        return { userIds: [], nextCursor: null, hasMore: false };
      }
      andConditions.push({ id: { in: uniqueUserIds } });
    } else if (audience.kind === 'ROLES') {
      const uniqueRoleIds = [...new Set(audience.roleIds ?? [])];
      if (uniqueRoleIds.length === 0) {
        return { userIds: [], nextCursor: null, hasMore: false };
      }
      andConditions.push({
        userRoles: {
          some: {
            tenantId,
            roleId: { in: uniqueRoleIds },
            deletedAt: null,
            ...(snapshotDate ? { createdAt: { lte: snapshotDate } } : {}),
            role: { tenantId, deletedAt: null },
          },
        },
      });
    } else if (audience.kind === 'PERMISSION') {
      const code = audience.code ?? '';
      andConditions.push({
        OR: [
          { isSuperAdmin: true },
          {
            userTenants: {
              some: {
                tenantId,
                status: 'ACTIVE',
                deletedAt: null,
                role: 'OWNER',
              },
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
          {
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
                      permission: {
                        code: { in: [code, '*'] },
                        deletedAt: null,
                      },
                    },
                  },
                },
              },
            },
          },
        ],
      });
    }

    const users = await this.prisma.user.findMany({
      where: {
        status: 'ACTIVE',
        deletedAt: null,
        ...(snapshotDate ? { createdAt: { lte: snapshotDate } } : {}),
        userTenants: {
          some: {
            tenantId,
            status: 'ACTIVE',
            deletedAt: null,
            ...(snapshotDate ? { createdAt: { lte: snapshotDate } } : {}),
            tenant: { status: 'ACTIVE', deletedAt: null },
          },
        },
        ...(andConditions.length > 0 ? { AND: andConditions } : {}),
      },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: limit + 1,
    });

    const hasMore = users.length > limit;
    const page = hasMore ? users.slice(0, limit) : users;
    const userIds = page.map((user) => user.id);

    return {
      userIds,
      nextCursor: hasMore ? (userIds.at(-1) ?? null) : null,
      hasMore,
    };
  }
}
