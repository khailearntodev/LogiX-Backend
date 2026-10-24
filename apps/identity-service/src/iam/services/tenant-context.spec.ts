import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { RolesService } from './roles.service.js';
import { PrismaService } from '../../database/prisma.service.js';

describe('IAM tenant context', () => {
  const current = randomUUID();
  const destination = randomUUID();
  const user = {
    id: randomUUID(),
    email: 'qa@example.test',
    displayName: 'QA',
    status: 'ACTIVE',
    tenantId: current,
  };
  const prisma = {
    tenant: { findFirst: vi.fn() },
    userTenant: { findFirst: vi.fn() },
    role: { findMany: vi.fn() },
    userRole: { deleteMany: vi.fn() },
  };
  let roles: RolesService;

  beforeEach(async () => {
    vi.resetAllMocks();
    prisma.tenant.findFirst.mockImplementation(
      ({ where }: { where: { id: string } }) =>
        Promise.resolve({ id: where.id }),
    );
    const module = await Test.createTestingModule({
      providers: [RolesService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    roles = module.get(RolesService);
  });

  it('allows an explicit Super Admin destination without membership', async () => {
    expect(
      await roles.resolveTenantId({ ...user, isSuperAdmin: true }, destination),
    ).toBe(destination);
    expect(prisma.tenant.findFirst).toHaveBeenCalledWith({
      where: { id: destination, status: 'ACTIVE', deletedAt: null },
      select: { id: true },
    });
  });

  it('ignores conflicting header scope for ordinary users', async () => {
    expect(
      await roles.resolveTenantId(
        { ...user, isSuperAdmin: false },
        destination,
      ),
    ).toBe(current);
  });

  it('rejects malformed header tenant instead of database errors', async () => {
    await expect(
      roles.resolveTenantId({ ...user, isSuperAdmin: true }, 'invalid'),
    ).rejects.toMatchObject({ status: 400 });
    expect(prisma.tenant.findFirst).not.toHaveBeenCalled();
  });

  it('does not let Super Admin header override lifecycle', async () => {
    prisma.tenant.findFirst.mockResolvedValue(null);
    await expect(
      roles.resolveTenantId({ ...user, isSuperAdmin: true }, destination),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('does not assign a legacy SUPER_ADMIN tenant role', async () => {
    prisma.userTenant.findFirst.mockResolvedValue({
      id: randomUUID(),
      role: 'MEMBER',
    });
    prisma.role.findMany.mockResolvedValue([
      { id: 'legacy-role', code: 'SUPER_ADMIN' },
    ]);
    await expect(
      roles.assignMemberRoles(current, 'other-user', ['legacy-role'], user.id),
    ).rejects.toMatchObject({ status: 400 });
    expect(prisma.userRole.deleteMany).not.toHaveBeenCalled();
  });
});
