import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import request from 'supertest';
import { PrismaService } from '../src/database/prisma.service.js';
import { MailService } from '../src/mail/services/mail.service.js';

// Explicit opt-in: this suite writes tagged fixtures and deletes only their recorded UUIDs.
describe.runIf(process.env.ADMIN_DATABASE_E2E === '1')(
  'Admin HTTP contract with PostgreSQL',
  () => {
    const tag = `qa${randomBytes(6).toString('hex')}`;
    let jwt: JwtService;
    const createdAt = new Date();
    const tenants = [
      'ACTIVE',
      'ACTIVE',
      'ACTIVE',
      'SUSPENDED',
      'DISABLED',
      'ACTIVE',
    ].map((status, index) => ({
      id: randomUUID(),
      code: `${tag}-${index}`,
      name: `${tag} Organization ${index}`,
      status,
      settings: {},
      createdAt,
      logoUrl: null,
      deletedAt: index === 5 ? createdAt : null,
    }));
    const users = [
      'ACTIVE',
      'ACTIVE',
      'ACTIVE',
      'LOCKED',
      'DISABLED',
      'ACTIVE',
      'ACTIVE',
    ].map((status, index) => ({
      id: randomUUID(),
      email: `${tag}-${index}@example.test`,
      displayName: `${tag} User ${index}`,
      phoneNumber: index === 2 ? '0900000000' : null,
      avatarUrl: index === 2 ? '/qa-avatar.png' : null,
      passwordHash: randomBytes(48).toString('hex'),
      status,
      isSuperAdmin: index < 2,
      createdAt,
      deletedAt: index === 6 ? createdAt : null,
    }));
    const tenantIds = tenants.map(({ id }) => id);
    const userIds = users.map(({ id }) => id);
    let database: PrismaService;
    let identity: INestApplication;
    let server: Server | string;
    const accessToken = (index = 0, extra: object = {}) =>
      jwt.sign(
        {
          sub: users[index].id,
          isSuperAdmin: users[index].isSuperAdmin,
          ...extra,
        },
        { expiresIn: 300 },
      );
    const get = (path: string, index = 0, extra: object = {}) =>
      request(server)
        .get(path)
        .set('Authorization', `Bearer ${accessToken(index, extra)}`);

    beforeAll(async () => {
      dotenv.config({ quiet: true });
      const databaseUrl = process.env.DATABASE_URL;
      if (!databaseUrl)
        throw new Error(
          'DATABASE_URL is required for the explicitly enabled admin database suite',
        );
      const gatewayUrl = process.env.ADMIN_GATEWAY_E2E_URL;
      const secret = gatewayUrl
        ? new ConfigService().getOrThrow<string>('JWT_SECRET')
        : randomBytes(48).toString('hex');
      jwt = new JwtService({ secret });
      vi.stubEnv('SERVICE_NAME', 'identity-admin-database-test');
      vi.stubEnv('NODE_ENV', 'test');
      vi.stubEnv('JWT_SECRET', secret);
      database = new PrismaService(
        new ConfigService({ DATABASE_URL: databaseUrl }),
      );
      await database.$connect();
      await database.$transaction([
        database.tenant.createMany({ data: tenants }),
        database.user.createMany({ data: users }),
        database.userTenant.createMany({
          data: [
            ...tenants.map((tenant, index) => ({
              id: randomUUID(),
              userId: users[1].id,
              tenantId: tenant.id,
              role: 'MEMBER',
              status: index === 1 ? 'INACTIVE' : 'ACTIVE',
              deletedAt: index === 2 ? createdAt : null,
            })),
            {
              id: randomUUID(),
              userId: users[2].id,
              tenantId: tenants[0].id,
              role: 'OWNER',
              status: 'ACTIVE',
            },
            ...[2, 3, 4, 5, 6].map((index) => ({
              id: randomUUID(),
              userId: users[index].id,
              tenantId: tenants[3].id,
              role: 'OWNER',
              status: index === 4 ? 'INACTIVE' : 'ACTIVE',
              deletedAt: index === 5 ? createdAt : null,
              createdAt: new Date(createdAt.getTime() - index * 1000),
            })),
          ],
        }),
      ]);
      if (gatewayUrl) {
        server = gatewayUrl;
        return;
      }
      const { AppModule: IdentityModule } =
        await import('../src/app.module.js');
      const identityModule = await Test.createTestingModule({
        imports: [IdentityModule],
      })
        .overrideProvider(PrismaService)
        .useValue(database)
        .overrideProvider(MailService)
        .useValue({})
        .compile();
      identity = identityModule.createNestApplication({ logger: false });
      identity.use(cookieParser());
      identity.setGlobalPrefix('api/v1');
      identity.useGlobalPipes(
        new ValidationPipe({
          whitelist: true,
          transform: true,
          forbidNonWhitelisted: true,
        }),
      );
      await identity.listen(0, '127.0.0.1');
      server = identity.getHttpServer();
    }, 60_000);

    afterAll(async () => {
      try {
        // Clean up before Identity closes its service-owned Prisma connection.
        if (database) {
          await database.$transaction([
            database.user.deleteMany({ where: { id: { in: userIds } } }),
            database.tenant.deleteMany({ where: { id: { in: tenantIds } } }),
          ]);
          expect(
            await database.user.count({ where: { id: { in: userIds } } }),
          ).toBe(0);
          expect(
            await database.tenant.count({ where: { id: { in: tenantIds } } }),
          ).toBe(0);
          expect(
            await database.userTenant.count({
              where: { userId: { in: userIds } },
            }),
          ).toBe(0);
        }
      } finally {
        await identity?.close();
        await database?.$disconnect();
        vi.unstubAllEnvs();
      }
    }, 60_000);

    it.each(['organizations', 'users'])(
      'paginates real %s rows, including final and out-of-range pages',
      async (resource) => {
        const expectedIds = (resource === 'users' ? users : tenants)
          .filter((row) => !row.deletedAt)
          .map(({ id }) => id)
          .sort();
        const received: string[] = [];
        for (const page of [1, 2, 3, 4]) {
          const response = await get(
            `/api/v1/admin/${resource}?q=${tag.toUpperCase()}&page=${page}&pageSize=2`,
          ).expect(200);
          expect(response.body).toMatchObject({
            page,
            pageSize: 2,
            total: expectedIds.length,
          });
          const ids = response.body.items.map(
            (item: { id: string }) => item.id,
          );
          expect(ids).toEqual(expectedIds.slice((page - 1) * 2, page * 2));
          received.push(...ids);
        }
        expect(received).toEqual(expectedIds);
        expect(new Set(received).size).toBe(expectedIds.length);
      },
    );

    it('counts only active, nondeleted memberships pointing to active, nondeleted tenants', async () => {
      const response = await get(`/api/v1/admin/users?q=${tag}`).expect(200);
      for (const item of response.body.items) {
        expect(item.tenantCount).toBe(
          item.id === users[1].id || item.id === users[2].id ? 1 : 0,
        );
        expect(Object.keys(item).sort()).toEqual(
          [
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
          ].sort(),
        );
        expect(item.lastLoginAt).toBeNull();
        expect(new Date(item.createdAt).toISOString()).toBe(item.createdAt);
      }
    });

    it('finds organizations by code/name and users by email/displayName, case insensitively', async () => {
      for (const q of [tenants[0].code, tenants[0].name]) {
        const response = await get(
          `/api/v1/admin/organizations?q=${encodeURIComponent(`  ${q.toUpperCase()}  `)}`,
        ).expect(200);
        expect(response.body.total).toBe(1);
        expect(response.body.items[0].id).toBe(tenants[0].id);
      }
      for (const q of [users[0].email, users[0].displayName]) {
        const response = await get(
          `/api/v1/admin/users?q=${encodeURIComponent(q.toUpperCase())}`,
        ).expect(200);
        expect(response.body.total).toBe(1);
        expect(response.body.items[0].id).toBe(users[0].id);
      }
    });

    it('returns one deterministic real owner, excludes invalid memberships/deleted users and preserves nullable contact data', async () => {
      const response = await get(`/api/v1/admin/organizations?q=${tag}`).expect(
        200,
      );
      const owned = response.body.items.find(
        (item: { id: string }) => item.id === tenants[3].id,
      );
      expect(owned.owner).toEqual({
        displayName: users[3].displayName,
        email: users[3].email,
        avatarUrl: null,
      });
      expect(
        response.body.items.find(
          (item: { id: string }) => item.id === tenants[1].id,
        ).owner,
      ).toBeNull();
      expect(owned).not.toHaveProperty('userTenants');
      const accounts = await get(`/api/v1/admin/users?q=${tag}`).expect(200);
      expect(
        accounts.body.items.find(
          (item: { id: string }) => item.id === users[2].id,
        ),
      ).toMatchObject({
        phoneNumber: users[2].phoneNumber,
        avatarUrl: users[2].avatarUrl,
      });
      expect(
        accounts.body.items.find(
          (item: { id: string }) => item.id === users[1].id,
        ),
      ).toMatchObject({
        phoneNumber: null,
        avatarUrl: null,
      });
    });

    it.each([
      ['organizations', 'ACTIVE', 3],
      ['organizations', 'SUSPENDED', 1],
      ['organizations', 'DISABLED', 1],
      ['users', 'ACTIVE', 4],
      ['users', 'LOCKED', 1],
      ['users', 'DISABLED', 1],
    ])(
      'filters %s by %s with a matching total',
      async (resource, status, total) => {
        const response = await get(
          `/api/v1/admin/${resource}?q=${tag}&status=${status}`,
        ).expect(200);
        expect(response.body.total).toBe(total);
        expect(response.body.items).toHaveLength(total);
        expect(
          response.body.items.every(
            (item: { status: string }) => item.status === status,
          ),
        ).toBe(true);
      },
    );

    it('retains platform authority without membership and with a MEMBER role; ignores tenant headers', async () => {
      const withoutMembership = await get(
        `/api/v1/admin/organizations?q=${tag}`,
      ).expect(200);
      const member = await get(`/api/v1/admin/organizations?q=${tag}`, 1, {
        tenantId: tenants[0].id,
      })
        .set('x-tenant-id', tenants[3].id)
        .expect(200);
      expect(member.body).toEqual(withoutMembership.body);
      expect(
        await database.userTenant.count({ where: { userId: users[0].id } }),
      ).toBe(0);
    });

    it('rejects an ordinary OWNER even when the token claims to be a Super Admin', async () => {
      const response = await get('/api/v1/admin/users', 2, {
        tenantId: tenants[0].id,
        isSuperAdmin: true,
      }).expect(403);
      expect(response.body.error).toBe('FORBIDDEN');
    });

    it('returns real authentication/validation HTTP errors 401/400', async () => {
      await request(server).get('/api/v1/admin/users').expect(401);
      const response = await get(
        '/api/v1/admin/organizations?pageSize=101',
      ).expect(400);
      expect(response.body.error).toBe('BAD_REQUEST');
    });

    it('returns an explicit empty result without clamping when no row matches', async () => {
      const response = await get(
        `/api/v1/admin/users?q=${tag}-no-match&page=9&pageSize=1`,
      ).expect(200);
      expect(response.body).toEqual({
        items: [],
        page: 9,
        pageSize: 1,
        total: 0,
      });
    });
  },
);
