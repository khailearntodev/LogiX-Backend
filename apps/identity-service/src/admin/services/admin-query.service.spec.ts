import { Test } from '@nestjs/testing';
import { PrismaService } from '../../database/prisma.service.js';
import { AdminQueryService } from './admin-query.service.js';
import {
  ListOrganizationsQueryDto,
  ListUsersQueryDto,
} from '../dto/list-admin-query.dto.js';

describe('AdminQueryService', () => {
  const tenant = { findMany: vi.fn(), count: vi.fn() };
  const user = { findMany: vi.fn(), count: vi.fn() };
  const transaction = vi.fn((queries: Promise<unknown>[]) =>
    Promise.all(queries),
  );
  let service: AdminQueryService;

  beforeEach(async () => {
    vi.clearAllMocks();
    tenant.findMany.mockResolvedValue([]);
    user.findMany.mockResolvedValue([]);
    tenant.count.mockResolvedValue(0);
    user.count.mockResolvedValue(0);
    const module = await Test.createTestingModule({
      providers: [
        AdminQueryService,
        {
          provide: PrismaService,
          useValue: { tenant, user, $transaction: transaction },
        },
      ],
    }).compile();
    service = module.get(AdminQueryService);
  });

  it('applies the same case-insensitive soft-delete/status filter to items and count', async () => {
    const query = Object.assign(new ListOrganizationsQueryDto(), {
      q: 'AcMe',
      status: 'SUSPENDED',
      page: 2,
      pageSize: 10,
    });
    expect(await service.listOrganizations(query)).toEqual({
      items: [],
      page: 2,
      pageSize: 10,
      total: 0,
    });
    const where = {
      deletedAt: null,
      status: 'SUSPENDED',
      OR: [
        { code: { contains: 'AcMe', mode: 'insensitive' } },
        { name: { contains: 'AcMe', mode: 'insensitive' } },
      ],
    };
    expect(tenant.count).toHaveBeenCalledWith({ where });
    expect(tenant.findMany).toHaveBeenCalledWith({
      where,
      skip: 10,
      take: 10,
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
            status: 'ACTIVE',
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
    });
    expect(transaction).toHaveBeenCalledWith(expect.any(Array), {
      isolationLevel: 'RepeatableRead',
    });
  });

  it('omits blank search/status filters and uses default pagination', async () => {
    await service.listOrganizations(new ListOrganizationsQueryDto());
    expect(tenant.count).toHaveBeenCalledWith({ where: { deletedAt: null } });
    expect(tenant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 0, take: 20 }),
    );
  });

  it('selects only safe user fields and counts qualifying memberships without N+1', async () => {
    const now = new Date();
    user.findMany.mockResolvedValue([
      {
        id: 'user',
        email: 'user@example.test',
        displayName: 'User',
        phoneNumber: '0900000000',
        avatarUrl: '/avatar.png',
        status: 'ACTIVE',
        isSuperAdmin: true,
        lastLoginAt: null,
        createdAt: now,
        updatedAt: now,
        _count: { userTenants: 0 },
      },
    ]);
    user.count.mockResolvedValue(1);
    const result = await service.listUsers(
      Object.assign(new ListUsersQueryDto(), { q: 'USER', status: 'ACTIVE' }),
    );
    expect(result.items[0]).toEqual({
      id: 'user',
      email: 'user@example.test',
      displayName: 'User',
      phoneNumber: '0900000000',
      avatarUrl: '/avatar.png',
      status: 'ACTIVE',
      isSuperAdmin: true,
      lastLoginAt: null,
      createdAt: now,
      updatedAt: now,
      tenantCount: 0,
    });
    const where = {
      deletedAt: null,
      status: 'ACTIVE',
      OR: [
        { email: { contains: 'USER', mode: 'insensitive' } },
        { displayName: { contains: 'USER', mode: 'insensitive' } },
      ],
    };
    expect(user.count).toHaveBeenCalledWith({ where });
    expect(user.findMany).toHaveBeenCalledWith({
      where,
      skip: 0,
      take: 20,
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
                status: 'ACTIVE',
                deletedAt: null,
                tenant: { status: 'ACTIVE', deletedAt: null },
              },
            },
          },
        },
      },
    });
    expect(user.findMany).toHaveBeenCalledTimes(1);
  });

  it.each([1, 2, 3, 4])(
    'preserves requested page %i and filtered total including empty pages',
    async (page) => {
      const items = page <= 3 ? [{ id: `org-${page}`, owner: null }] : [];
      tenant.findMany.mockResolvedValue(
        page <= 3 ? [{ id: `org-${page}`, userTenants: [] }] : [],
      );
      tenant.count.mockResolvedValue(3);
      expect(
        await service.listOrganizations(
          Object.assign(new ListOrganizationsQueryDto(), { page, pageSize: 1 }),
        ),
      ).toEqual({ items, page, pageSize: 1, total: 3 });
      expect(tenant.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: page - 1, take: 1 }),
      );
    },
  );

  it('returns one safe owner projection or null, never membership details or invented ownership', async () => {
    const owner = {
      displayName: 'Owner',
      email: 'owner@example.test',
      avatarUrl: null,
    };
    tenant.findMany.mockResolvedValue([
      { id: 'with-owner', userTenants: [{ user: owner }] },
      { id: 'without-owner', userTenants: [] },
    ]);
    tenant.count.mockResolvedValue(2);
    const result = await service.listOrganizations(
      new ListOrganizationsQueryDto(),
    );
    expect(result.items).toEqual([
      { id: 'with-owner', owner },
      { id: 'without-owner', owner: null },
    ]);
    expect(tenant.findMany).toHaveBeenCalledTimes(1);
  });

  it.each(['organizations', 'users'])(
    'rejects an offset beyond Prisma integer bounds: %s',
    async (resource) => {
      const result =
        resource === 'users'
          ? service.listUsers(
              Object.assign(new ListUsersQueryDto(), {
                page: Number.MAX_SAFE_INTEGER,
              }),
            )
          : service.listOrganizations(
              Object.assign(new ListOrganizationsQueryDto(), {
                page: Number.MAX_SAFE_INTEGER,
              }),
            );
      await expect(result).rejects.toMatchObject({ status: 400 });
      expect(transaction).not.toHaveBeenCalled();
    },
  );

  it('propagates database failures, never returning an empty success', async () => {
    tenant.count.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(
      service.listOrganizations(new ListOrganizationsQueryDto()),
    ).rejects.toThrow('database unavailable');
  });
});
