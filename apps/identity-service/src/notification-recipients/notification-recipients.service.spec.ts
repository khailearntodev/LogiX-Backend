import { randomUUID } from 'node:crypto';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { PrismaService } from '../database/prisma.service.js';
import { ResolveNotificationRecipientsDto } from './notification-recipients.dto.js';
import { NotificationRecipientsService } from './notification-recipients.service.js';

describe('NotificationRecipientsService', () => {
  it('resolves active tenant users by permission including OWNER and wildcard', async () => {
    const tenantId = randomUUID();
    const userId = randomUUID();
    const findMany = vi.fn().mockResolvedValue([{ id: userId }]);
    const prisma = { user: { findMany } } as unknown as PrismaService;
    const service = new NotificationRecipientsService(prisma);

    await expect(
      service.resolve(tenantId, {
        audience: { kind: 'PERMISSION', code: 'transport:trip:dispatch' },
      }),
    ).resolves.toEqual({ userIds: [userId], nextCursor: null, hasMore: false });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { id: 'asc' },
        take: 501,
        where: expect.objectContaining({
          status: 'ACTIVE',
          deletedAt: null,
          userTenants: expect.objectContaining({
            some: expect.objectContaining({
              tenantId,
              status: 'ACTIVE',
              deletedAt: null,
            }),
          }),
        }),
      }),
    );
  });

  it('resolves ALL active tenant members with snapshotAt cutoff and keyset pagination', async () => {
    const tenantId = randomUUID();
    const u1 = randomUUID();
    const u2 = randomUUID();
    const u3 = randomUUID();
    const cursor = randomUUID();
    const snapshotAt = '2026-11-27T10:00:00.000Z';
    const findMany = vi.fn().mockResolvedValue([{ id: u1 }, { id: u2 }, { id: u3 }]);
    const prisma = { user: { findMany } } as unknown as PrismaService;
    const service = new NotificationRecipientsService(prisma);

    await expect(
      service.resolve(tenantId, {
        audience: { kind: 'ALL' },
        limit: 2,
        cursor,
        snapshotAt,
      }),
    ).resolves.toEqual({
      userIds: [u1, u2],
      nextCursor: u2,
      hasMore: true,
    });

    expect(findMany).toHaveBeenCalledWith({
      where: {
        status: 'ACTIVE',
        deletedAt: null,
        createdAt: { lte: new Date(snapshotAt) },
        userTenants: {
          some: {
            tenantId,
            status: 'ACTIVE',
            deletedAt: null,
            createdAt: { lte: new Date(snapshotAt) },
            tenant: { status: 'ACTIVE', deletedAt: null },
          },
        },
        AND: [{ id: { gt: cursor } }],
      },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: 3,
    });
  });

  it('resolves ROLES audience strictly scoped to tenant roles and active memberships', async () => {
    const tenantId = randomUUID();
    const role1 = randomUUID();
    const role2 = randomUUID();
    const user1 = randomUUID();
    const findMany = vi.fn().mockResolvedValue([{ id: user1 }]);
    const prisma = { user: { findMany } } as unknown as PrismaService;
    const service = new NotificationRecipientsService(prisma);

    await expect(
      service.resolve(tenantId, {
        audience: { kind: 'ROLES', roleIds: [role1, role2, role1] },
      }),
    ).resolves.toEqual({ userIds: [user1], nextCursor: null, hasMore: false });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: [
            {
              userRoles: {
                some: {
                  tenantId,
                  roleId: { in: [role1, role2] },
                  deletedAt: null,
                  role: { tenantId, deletedAt: null },
                },
              },
            },
          ],
        }),
      }),
    );
  });

  it('filters USERS audience by active status, tenant membership, and cursor via AND', async () => {
    const tenantId = randomUUID();
    const user1 = randomUUID();
    const user2 = randomUUID();
    const cursor = randomUUID();
    const findMany = vi.fn().mockResolvedValue([{ id: user1 }]);
    const prisma = { user: { findMany } } as unknown as PrismaService;
    const service = new NotificationRecipientsService(prisma);

    await expect(
      service.resolve(tenantId, {
        audience: { kind: 'USERS', userIds: [user1, user2, user1] },
        cursor,
      }),
    ).resolves.toEqual({ userIds: [user1], nextCursor: null, hasMore: false });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'ACTIVE',
          deletedAt: null,
          AND: [{ id: { gt: cursor } }, { id: { in: [user1, user2] } }],
        }),
      }),
    );
  });

  it('returns empty paginated result without querying DB when USERS or ROLES list is empty', async () => {
    const findMany = vi.fn();
    const prisma = { user: { findMany } } as unknown as PrismaService;
    const service = new NotificationRecipientsService(prisma);

    await expect(
      service.resolve(randomUUID(), { audience: { kind: 'USERS', userIds: [] } }),
    ).resolves.toEqual({ userIds: [], nextCursor: null, hasMore: false });
    await expect(
      service.resolve(randomUUID(), { audience: { kind: 'ROLES', roleIds: [] } }),
    ).resolves.toEqual({ userIds: [], nextCursor: null, hasMore: false });
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe('ResolveNotificationRecipientsDto', () => {
  it('accepts valid ALL, ROLES, USERS, and PERMISSION requests with keyset options', async () => {
    const valid = plainToInstance(ResolveNotificationRecipientsDto, {
      audience: { kind: 'ROLES', roleIds: [randomUUID()] },
      limit: 500,
      cursor: randomUUID(),
      snapshotAt: '2026-11-27T10:00:00.000Z',
    });
    expect(await validate(valid)).toEqual([]);

    const allWithNulls = plainToInstance(ResolveNotificationRecipientsDto, {
      audience: { kind: 'ALL' },
      cursor: null,
      snapshotAt: null,
    });
    expect(await validate(allWithNulls)).toEqual([]);
  });

  it('rejects empty ROLES/USERS arrays, out-of-range limit, and invalid cursor', async () => {
    const emptyRoles = plainToInstance(ResolveNotificationRecipientsDto, {
      audience: { kind: 'ROLES', roleIds: [] },
    });
    expect((await validate(emptyRoles)).length).toBeGreaterThan(0);

    const badLimit = plainToInstance(ResolveNotificationRecipientsDto, {
      audience: { kind: 'ALL' },
      limit: 501,
    });
    expect((await validate(badLimit)).length).toBeGreaterThan(0);

    const badCursor = plainToInstance(ResolveNotificationRecipientsDto, {
      audience: { kind: 'ALL' },
      cursor: 'not-a-uuid',
    });
    expect((await validate(badCursor)).length).toBeGreaterThan(0);
  });
});
