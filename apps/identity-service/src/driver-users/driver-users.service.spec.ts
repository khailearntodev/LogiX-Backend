import {
  DriverUsersService,
  eligibleDriverUserWhere,
} from './driver-users.service.js';
import { PrismaService } from '../database/prisma.service.js';

describe('Driver user lookup scoping', () => {
  it('requires active tenant membership even for a Super Admin candidate', () => {
    const where = eligibleDriverUserWhere('tenant');
    expect(where).toMatchObject({
      status: 'ACTIVE',
      deletedAt: null,
      userTenants: {
        some: {
          tenantId: 'tenant',
          status: 'ACTIVE',
          deletedAt: null,
          tenant: { status: 'ACTIVE', deletedAt: null },
        },
      },
    });
  });
  it('combines search and capability before pagination and count', async () => {
    const findMany = vi.fn().mockResolvedValue([]),
      count = vi.fn().mockResolvedValue(0);
    const prisma = {
      user: { findMany, count },
      $transaction: (promises: Promise<unknown>[]) => Promise.all(promises),
    };
    const service = new DriverUsersService(prisma as unknown as PrismaService);
    await expect(
      service.list('tenant', { q: 'driver', page: 2, pageSize: 1 }),
    ).resolves.toEqual({ items: [], total: 0, page: 2, pageSize: 1 });
    const query = findMany.mock.calls[0][0];
    expect(query.skip).toBe(1);
    expect(query.take).toBe(1);
    expect(count.mock.calls[0][0].where).toEqual(query.where);
    expect(query.where.AND).toHaveLength(2);
  });
  it('does not return success for identities outside tenant membership', async () => {
    const service = new DriverUsersService({
      user: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as PrismaService);
    await expect(service.resolve('tenant', ['missing-user'])).rejects.toThrow(
      'Không tìm thấy',
    );
  });
});
