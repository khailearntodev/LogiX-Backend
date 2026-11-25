import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import type { ResolveNotificationRecipientsDto } from './notification-recipients.dto.js';

@Injectable()
export class NotificationRecipientsService {
  constructor(private readonly prisma: PrismaService) {}

  resolve(tenantId: string, audience: ResolveNotificationRecipientsDto) {
    if (audience.kind === 'USERS') {
      return this.resolveActiveUsers(tenantId, audience.userIds ?? []);
    }
    return this.resolveByPermission(tenantId, audience.code ?? '');
  }

  async resolveActiveUsers(tenantId: string, userIds: string[]) {
    const uniqueUserIds = [...new Set(userIds)];
    if (uniqueUserIds.length === 0) {
      return { userIds: [] };
    }

    const users = await this.prisma.user.findMany({
      where: {
        id: { in: uniqueUserIds },
        status: 'ACTIVE',
        deletedAt: null,
        userTenants: {
          some: {
            tenantId,
            status: 'ACTIVE',
            deletedAt: null,
            tenant: { status: 'ACTIVE', deletedAt: null },
          },
        },
      },
      select: { id: true },
      orderBy: { id: 'asc' },
    });

    return { userIds: users.map((user) => user.id) };
  }

  async resolveByPermission(tenantId: string, code: string) {
    const users = await this.prisma.user.findMany({
      where: {
        status: 'ACTIVE',
        deletedAt: null,
        userTenants: {
          some: {
            tenantId,
            status: 'ACTIVE',
            deletedAt: null,
            tenant: { status: 'ACTIVE', deletedAt: null },
          },
        },
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
                      permission: { code: { in: [code, '*'] }, deletedAt: null },
                    },
                  },
                },
              },
            },
          },
        ],
      },
      select: { id: true },
      orderBy: { id: 'asc' },
    });

    return { userIds: users.map((user) => user.id) };
  }
}
