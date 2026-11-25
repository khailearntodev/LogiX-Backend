import { randomUUID } from 'node:crypto';
import type { PrismaService } from '../database/prisma.service.js';
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
        kind: 'PERMISSION',
        code: 'transport:trip:dispatch',
      }),
    ).resolves.toEqual({ userIds: [userId] });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'ACTIVE',
          deletedAt: null,
          userTenants: expect.objectContaining({
            some: expect.objectContaining({ tenantId, status: 'ACTIVE', deletedAt: null }),
          }),
        }),
      }),
    );
  });

  it('filters USERS audience by active status and tenant membership', async () => {
    const tenantId = randomUUID();
    const user1 = randomUUID();
    const user2 = randomUUID();
    const findMany = vi.fn().mockResolvedValue([{ id: user1 }]);
    const prisma = { user: { findMany } } as unknown as PrismaService;
    const service = new NotificationRecipientsService(prisma);

    await expect(
      service.resolve(tenantId, {
        kind: 'USERS',
        userIds: [user1, user2, user1],
      }),
    ).resolves.toEqual({ userIds: [user1] });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: [user1, user2] },
          status: 'ACTIVE',
          deletedAt: null,
          userTenants: expect.objectContaining({
            some: expect.objectContaining({ tenantId, status: 'ACTIVE', deletedAt: null }),
          }),
        }),
      }),
    );
  });

  it('returns empty list without querying DB when USERS array is empty', async () => {
    const findMany = vi.fn();
    const prisma = { user: { findMany } } as unknown as PrismaService;
    const service = new NotificationRecipientsService(prisma);

    await expect(
      service.resolve(randomUUID(), { kind: 'USERS', userIds: [] }),
    ).resolves.toEqual({ userIds: [] });
    expect(findMany).not.toHaveBeenCalled();
  });
});
