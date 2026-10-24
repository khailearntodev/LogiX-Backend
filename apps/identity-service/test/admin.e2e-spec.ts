import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { Module, ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { GlobalExceptionFilter } from '@logix/errors';
import { AdminModule } from '../src/admin/admin.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { JwtAuthGuard } from '../src/auth/guards/jwt-auth.guard.js';
import { JwtStrategy } from '../src/auth/strategies/jwt.strategy.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { RolesService } from '../src/iam/services/roles.service.js';

const secret = randomBytes(48).toString('hex');
const jwt = new JwtService({ secret });
const principalId = randomUUID();
const tenantId = randomUUID();
const now = new Date('2026-01-01T00:00:00.000Z');
const organization = {
  id: tenantId,
  code: 'fixture',
  name: 'Fixture',
  status: 'ACTIVE',
  logoUrl: null,
  createdAt: now,
  updatedAt: now,
  userTenants: [],
};
const userItem = {
  id: principalId,
  email: 'fixture@example.test',
  displayName: 'Fixture',
  phoneNumber: null,
  avatarUrl: null,
  status: 'ACTIVE',
  isSuperAdmin: true,
  lastLoginAt: null,
  createdAt: now,
  updatedAt: now,
  _count: { userTenants: 0 },
};
const principal = (isSuperAdmin: boolean, role?: string) => ({
  id: principalId,
  email: userItem.email,
  displayName: userItem.displayName,
  status: 'ACTIVE',
  isSuperAdmin,
  userTenants: role ? [{ tenantId, role, tenant: organization }] : [],
});
const prisma = {
  user: { findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn() },
  tenant: { findMany: vi.fn(), count: vi.fn() },
  $transaction: vi.fn((queries: Promise<unknown>[]) => Promise.all(queries)),
};
const roles = {
  getEffectivePermissions: vi.fn().mockResolvedValue({ permissions: ['*'] }),
};

@Module({
  imports: [PassportModule.register({ defaultStrategy: 'jwt' })],
  providers: [
    JwtAuthGuard,
    { provide: RolesService, useValue: roles },
    {
      provide: JwtStrategy,
      useFactory: (database: PrismaService, roleService: RolesService) =>
        new JwtStrategy(
          database,
          new ConfigService({ JWT_SECRET: secret }),
          roleService,
        ),
      inject: [PrismaService, RolesService],
    },
  ],
  exports: [JwtAuthGuard, PassportModule],
})
class TestAuthModule {}

describe('Admin HTTP contract (real JWT/guards/controller/service; mocked persistence)', () => {
  let app: INestApplication;
  let server: Server;
  const token = (payload: object = {}, expiresIn = 60) =>
    jwt.sign(
      { sub: principalId, isSuperAdmin: true, ...payload },
      { expiresIn },
    );

  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AdminModule] })
      .overrideModule(AuthModule)
      .useModule(TestAuthModule)
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();
    app = module.createNestApplication({ logger: false });
    app.use(cookieParser());
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    app.useGlobalFilters(new GlobalExceptionFilter());
    await app.listen(0, '127.0.0.1');
    server = app.getHttpServer();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.user.findFirst.mockResolvedValue(principal(true));
    prisma.tenant.findMany.mockResolvedValue([organization]);
    prisma.tenant.count.mockResolvedValue(1);
    prisma.user.findMany.mockResolvedValue([userItem]);
    prisma.user.count.mockResolvedValue(1);
  });

  afterAll(async () => {
    await app?.close();
  });

  it.each(['organizations', 'users'])(
    'returns a safe paginated %s projection without a tenant',
    async (resource) => {
      const result = await request(server)
        .get(`/api/v1/admin/${resource}`)
        .set('Authorization', `Bearer ${token()}`)
        .expect(200);
      expect(result.body).toMatchObject({ page: 1, pageSize: 20, total: 1 });
      const item = result.body.items[0];
      expect(Object.keys(item).sort()).toEqual(
        (resource === 'users'
          ? [
              'id',
              'email',
              'displayName',
              'phoneNumber',
              'avatarUrl',
              'status',
              'isSuperAdmin',
              'lastLoginAt',
              'createdAt',
              'updatedAt',
              'tenantCount',
            ]
          : [
              'id',
              'code',
              'name',
              'status',
              'logoUrl',
              'owner',
              'createdAt',
              'updatedAt',
            ]
        ).sort(),
      );
      expect(item.createdAt).toBe(now.toISOString());
      expect(item.updatedAt).toBe(now.toISOString());
      if (resource === 'users') {
        expect(item.tenantCount).toBe(0);
        expect(item.lastLoginAt).toBeNull();
      } else {
        expect(item.logoUrl).toBeNull();
      }
    },
  );

  it.each(['organizations', 'users'])(
    'returns 401 before querying %s for invalid sessions',
    async (resource) => {
      for (const credential of [undefined, 'invalid', token({}, -1)]) {
        const call = request(server).get(`/api/v1/admin/${resource}`);
        if (credential) call.set('Authorization', `Bearer ${credential}`);
        const response = await call.expect(401);
        expect(response.body).toMatchObject({
          statusCode: 401,
          error: 'UNAUTHORIZED',
        });
        expect(response.body.timestamp).toEqual(expect.any(String));
      }
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it.each(['OWNER', 'ADMIN', 'MEMBER'])(
    'returns 403 for %s/wildcard despite a forged super-admin claim',
    async (role) => {
      prisma.user.findFirst.mockResolvedValue(principal(false, role));
      for (const resource of ['organizations', 'users']) {
        const result = await request(server)
          .get(`/api/v1/admin/${resource}`)
          .set('Authorization', `Bearer ${token({ tenantId })}`)
          .expect(403);
        expect(result.body.error).toBe('FORBIDDEN');
      }
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it('accepts cookie credentials and ignores a conflicting tenant header in the global query', async () => {
    await request(server)
      .get('/api/v1/admin/users')
      .set('Cookie', `accessToken=${token()}`)
      .set('x-tenant-id', randomUUID())
      .expect(200);
    expect(prisma.user.count).toHaveBeenCalledWith({
      where: { deletedAt: null },
    });
  });

  it('rejects an inactive/deleted principal according to the existing JWT strategy', async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    await request(server)
      .get('/api/v1/admin/users')
      .set('Authorization', `Bearer ${token()}`)
      .expect(401);
    expect(prisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: principalId, status: 'ACTIVE', deletedAt: null },
      }),
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each(['organizations', 'users'])(
    'validates %s query before persistence and preserves correlation',
    async (resource) => {
      for (const query of [
        'page=0',
        'pageSize=101',
        'page=1.5',
        'page=9007199254740992',
        'page=2147483649&pageSize=100',
        'q=a&q=b',
        'page=1&page=2',
        'status=INACTIVE',
        `q=${'a'.repeat(201)}`,
        'unexpected=1',
        resource === 'users' ? 'status=SUSPENDED' : 'status=LOCKED',
      ]) {
        const response = await request(server)
          .get(`/api/v1/admin/${resource}?${query}`)
          .set('Authorization', `Bearer ${token()}`)
          .set('x-correlation-id', 'admin-contract-test')
          .expect(400);
        expect(response.body).toMatchObject({
          error: 'BAD_REQUEST',
          correlationId: 'admin-contract-test',
        });
      }
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it('keeps requested out-of-range metadata, rather than clamping page or total', async () => {
    prisma.tenant.findMany.mockResolvedValue([]);
    const response = await request(server)
      .get('/api/v1/admin/organizations?page=4&pageSize=1')
      .set('Authorization', `Bearer ${token()}`)
      .expect(200);
    expect(response.body).toEqual({
      items: [],
      page: 4,
      pageSize: 1,
      total: 1,
    });
  });

  it('returns a sanitized 500, not an empty 200, on database failure', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      prisma.user.count.mockRejectedValueOnce(
        new Error('private database failure'),
      );
      const response = await request(server)
        .get('/api/v1/admin/users')
        .set('Authorization', `Bearer ${token()}`)
        .expect(500);
      expect(response.body).toMatchObject({
        statusCode: 500,
        error: 'INTERNAL_ERROR',
      });
      expect(JSON.stringify(response.body)).not.toMatch(
        /private|stack|password|tokenVersion/,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
