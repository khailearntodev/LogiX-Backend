import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import request, { type Response as TestResponse } from 'supertest';
import { PrismaService } from '../src/database/prisma.service.js';
import { MailService } from '../src/mail/services/mail.service.js';

// Opt-in database writes; all mutations and cleanup are restricted to recorded fixture IDs.
describe.runIf(process.env.ADMIN_DATABASE_E2E === '1')(
  'Super Admin context HTTP/PostgreSQL',
  () => {
    const tag = `qa-p3-${randomBytes(5).toString('hex')}`;
    const tenantIds = Array.from({ length: 6 }, () => randomUUID());
    const userIds = Array.from({ length: 6 }, () => randomUUID());
    const membershipIds = Array.from({ length: 5 }, () => randomUUID());
    const ownerRoleId = randomUUID();
    const memberRoleId = randomUUID();
    const permissionId = randomUUID();
    const invitationId = randomUUID();
    const gatewayUrl = process.env.ADMIN_GATEWAY_E2E_URL;
    const mail = { sendInvitationEmail: vi.fn().mockResolvedValue(undefined) };
    let database: PrismaService;
    let app: INestApplication;
    let server: Server | string;
    let jwt: JwtService;
    const token = (index = 0, tenantId: string = tenantIds[0]) =>
      jwt.sign(
        {
          sub: userIds[index],
          email: `${tag}-${index}@example.test`,
          tenantId,
          role: 'MEMBER',
          isSuperAdmin: index < 2,
        },
        { expiresIn: 300 },
      );
    const call = (
      method: 'get' | 'post' | 'patch' | 'put' | 'delete',
      path: string,
      accessToken = token(),
    ) =>
      request(server)
        [method](`/api/v1${path}`)
        .set('Authorization', `Bearer ${accessToken}`);
    const refreshCookie = (response: TestResponse) => {
      const rawCookies: unknown = response.headers['set-cookie'];
      const cookies = Array.isArray(rawCookies)
        ? rawCookies.filter(
            (value): value is string => typeof value === 'string',
          )
        : typeof rawCookies === 'string'
          ? [rawCookies]
          : [];
      const cookie = cookies.find((value) => value.startsWith('refreshToken='));
      if (!cookie)
        throw new Error(
          'Expected HttpOnly refresh cookie after switch/refresh',
        );
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('Path=/api/v1/auth');
      return cookie.split(';')[0];
    };

    beforeAll(async () => {
      dotenv.config({ quiet: true });
      const config = new ConfigService();
      const secret = gatewayUrl
        ? config.getOrThrow<string>('JWT_SECRET')
        : randomBytes(48).toString('hex');
      jwt = new JwtService({ secret });
      vi.stubEnv('SERVICE_NAME', 'identity-super-admin-context-test');
      vi.stubEnv('NODE_ENV', 'test');
      vi.stubEnv('JWT_SECRET', secret);
      database = new PrismaService(
        new ConfigService({
          DATABASE_URL: config.getOrThrow<string>('DATABASE_URL'),
        }),
      );
      await database.$connect();
      await database.$transaction([
        database.tenant.createMany({
          data: tenantIds.map((id, index) => ({
            id,
            code: `${tag}-${index}`,
            name: `${tag} Tenant ${index}`,
            settings: {},
            status:
              index === 2 ? 'SUSPENDED' : index === 3 ? 'DISABLED' : 'ACTIVE',
            deletedAt: index === 4 ? new Date() : null,
          })),
        }),
        database.user.createMany({
          data: userIds.map((id, index) => ({
            id,
            email: `${tag}-${index}@example.test`,
            displayName: `${tag} User ${index}`,
            passwordHash: randomBytes(48).toString('hex'),
            status: 'ACTIVE',
            isSuperAdmin: index < 2,
          })),
        }),
        database.userTenant.createMany({
          data: [
            {
              id: membershipIds[0],
              userId: userIds[0],
              tenantId: tenantIds[0],
              role: 'MEMBER',
              isDefault: true,
              status: 'ACTIVE',
            },
            {
              id: membershipIds[1],
              userId: userIds[2],
              tenantId: tenantIds[1],
              role: 'OWNER',
              isDefault: true,
              status: 'ACTIVE',
            },
            {
              id: membershipIds[2],
              userId: userIds[3],
              tenantId: tenantIds[0],
              role: 'MEMBER',
              isDefault: true,
              status: 'ACTIVE',
            },
            {
              id: membershipIds[3],
              userId: userIds[4],
              tenantId: tenantIds[1],
              role: 'MEMBER',
              status: 'ACTIVE',
            },
            {
              id: membershipIds[4],
              userId: userIds[5],
              tenantId: tenantIds[1],
              role: 'MEMBER',
              status: 'ACTIVE',
            },
          ],
        }),
        database.role.createMany({
          data: [
            {
              id: ownerRoleId,
              tenantId: tenantIds[1],
              code: 'OWNER',
              name: 'Owner',
              isSystem: true,
            },
            {
              id: memberRoleId,
              tenantId: tenantIds[1],
              code: 'MEMBER',
              name: 'Member',
              isSystem: true,
            },
          ],
        }),
        database.permission.create({
          data: {
            id: permissionId,
            module: 'qa',
            resource: tag,
            action: 'read',
            code: `qa:${tag}:read`,
            name: 'QA fixture permission',
          },
        }),
        database.tenantInvitation.create({
          data: {
            id: invitationId,
            tenantId: tenantIds[1],
            email: `${tag}-invite@example.test`,
            roleIds: [memberRoleId],
            inviterId: userIds[2],
            token: randomBytes(32).toString('hex'),
            expiresAt: new Date(Date.now() + 60_000),
          },
        }),
      ]);
      if (gatewayUrl) {
        server = gatewayUrl;
        return;
      }
      const { AppModule } = await import('../src/app.module.js');
      const module = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(PrismaService)
        .useValue(database)
        .overrideProvider(MailService)
        .useValue(mail)
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
      await app.listen(0, '127.0.0.1');
      server = app.getHttpServer();
    }, 60_000);

    afterAll(async () => {
      try {
        if (database) {
          await database.$transaction([
            database.session.deleteMany({ where: { userId: { in: userIds } } }),
            database.tenantInvitation.deleteMany({
              where: { tenantId: { in: tenantIds } },
            }),
            database.userRole.deleteMany({
              where: { tenantId: { in: tenantIds } },
            }),
            database.rolePermission.deleteMany({
              where: { tenantId: { in: tenantIds } },
            }),
            database.role.deleteMany({
              where: { tenantId: { in: tenantIds } },
            }),
            database.permission.deleteMany({ where: { id: permissionId } }),
            database.user.deleteMany({ where: { id: { in: userIds } } }),
            database.tenant.deleteMany({ where: { id: { in: tenantIds } } }),
          ]);
          const remaining = await Promise.all([
            database.session.count({ where: { userId: { in: userIds } } }),
            database.userTenant.count({ where: { userId: { in: userIds } } }),
            database.tenantInvitation.count({
              where: { tenantId: { in: tenantIds } },
            }),
            database.userRole.count({ where: { tenantId: { in: tenantIds } } }),
            database.rolePermission.count({
              where: { tenantId: { in: tenantIds } },
            }),
            database.role.count({ where: { tenantId: { in: tenantIds } } }),
            database.permission.count({ where: { id: permissionId } }),
            database.user.count({ where: { id: { in: userIds } } }),
            database.tenant.count({ where: { id: { in: tenantIds } } }),
          ]);
          expect(remaining).toEqual(Array(9).fill(0));
        }
      } finally {
        await app?.close();
        await database?.$disconnect();
        vi.unstubAllEnvs();
      }
    }, 60_000);

    it('switches MEMBER at A to nonmember B, reads profile, rotates refresh, retains authority and persisted default A', async () => {
      const before = await database.userTenant.findMany({
        where: { userId: userIds[0] },
      });
      const switched = await call('post', '/auth/switch-tenant')
        .send({ tenantId: tenantIds[1] })
        .expect(200);
      const accessToken: string = switched.body.accessToken;
      expect(switched.body.activeTenant).toMatchObject({
        id: tenantIds[1],
        role: 'SUPER_ADMIN',
      });
      expect(jwt.decode(accessToken)).toMatchObject({
        sub: userIds[0],
        tenantId: tenantIds[1],
        role: 'SUPER_ADMIN',
        isSuperAdmin: true,
        permissions: ['*'],
      });
      const cookie = refreshCookie(switched);
      for (let reload = 0; reload < 2; reload++) {
        const profile = await call('get', '/auth/me', accessToken).expect(200);
        expect(profile.body.activeTenant).toMatchObject({
          id: tenantIds[1],
          role: 'SUPER_ADMIN',
        });
        expect(profile.body.tenants).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: tenantIds[0],
              role: 'MEMBER',
              isDefault: true,
            }),
            expect.objectContaining({
              id: tenantIds[1],
              role: 'SUPER_ADMIN',
              isDefault: false,
            }),
          ]),
        );
      }
      const refreshed = await request(server)
        .post('/api/v1/auth/refresh')
        .set('Cookie', cookie)
        .send({})
        .expect(200);
      expect(refreshed.body.activeTenant.id).toBe(tenantIds[1]);
      expect(refreshed.body.user).toMatchObject({
        id: userIds[0],
        isSuperAdmin: true,
      });
      expect(jwt.decode(refreshed.body.accessToken)).toMatchObject({
        tenantId: tenantIds[1],
        isSuperAdmin: true,
        role: 'SUPER_ADMIN',
      });
      const refreshedCookie = refreshCookie(refreshed);
      expect(refreshedCookie === cookie).toBe(false);
      await request(server)
        .post('/api/v1/auth/refresh')
        .set('Cookie', cookie)
        .send({})
        .expect(401);
      const rights = await call(
        'get',
        '/auth/me/permissions',
        refreshed.body.accessToken,
      ).expect(200);
      expect(rights.body).toMatchObject({
        isSuperAdmin: true,
        permissions: ['*'],
      });
      const details = await call(
        'get',
        `/auth/organizations/${tenantIds[1]}`,
        refreshed.body.accessToken,
      ).expect(200);
      expect(details.body).toMatchObject({
        id: tenantIds[1],
        role: 'SUPER_ADMIN',
        isDefault: false,
      });
      expect(
        await database.userTenant.findMany({ where: { userId: userIds[0] } }),
      ).toEqual(before);
      expect(
        await database.userRole.count({ where: { userId: userIds[0] } }),
      ).toBe(0);
    });

    it('keeps full authority for actual MEMBER at A and a Super Admin without any memberships', async () => {
      const rights = await call('get', '/auth/me/permissions').expect(200);
      expect(rights.body.isSuperAdmin).toBe(true);
      const profile = await call('get', '/auth/me').expect(200);
      expect(profile.body.activeTenant.role).toBe('MEMBER');
      await call('patch', `/auth/organizations/${tenantIds[0]}`)
        .send({ name: `${tag} Updated A` })
        .expect(200);
      const onlyPlatform = token(1, '');
      const switched = await call('post', '/auth/switch-tenant', onlyPlatform)
        .send({ tenantId: tenantIds[1] })
        .expect(200);
      const platformProfile = await call(
        'get',
        '/auth/me',
        switched.body.accessToken,
      ).expect(200);
      expect(platformProfile.body.activeTenant.id).toBe(tenantIds[1]);
      expect(platformProfile.body.tenants).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: tenantIds[0],
            role: 'SUPER_ADMIN',
            isDefault: false,
          }),
          expect.objectContaining({
            id: tenantIds[1],
            role: 'SUPER_ADMIN',
            isDefault: false,
          }),
        ]),
      );
      await call(
        'get',
        `/auth/organizations/${tenantIds[1]}/members`,
        switched.body.accessToken,
      ).expect(200);
      expect(
        await database.userTenant.count({ where: { userId: userIds[1] } }),
      ).toBe(0);
    });

    it('updates organization/legal profile without membership and preserves legal-address validation', async () => {
      await call('patch', `/auth/organizations/${tenantIds[1]}`)
        .send({
          name: `${tag} Updated B`,
          legalName: `${tag} Legal`,
          addressLine: 'QA street',
          province: 'QA province',
        })
        .expect(200);
      expect(
        await database.tenant.findUnique({ where: { id: tenantIds[1] } }),
      ).toMatchObject({
        name: `${tag} Updated B`,
        legalName: `${tag} Legal`,
        addressLine: 'QA street',
        province: 'QA province',
      });
      await call('patch', `/auth/organizations/${tenantIds[1]}`)
        .send({ province: null })
        .expect(400);
      expect(
        (
          await database.tenant.findUniqueOrThrow({
            where: { id: tenantIds[1] },
          })
        ).province,
      ).toBe('QA province');
    });

    it('manages roles/matrix/member assignment without membership; keeps tenant and system-role invariants', async () => {
      const header = { 'x-tenant-id': tenantIds[1] };
      const created = await call('post', '/iam/roles')
        .set(header)
        .send({
          code: `QA_${randomBytes(4).toString('hex').toUpperCase()}`,
          name: `${tag} Custom`,
          permissionIds: [permissionId],
        })
        .expect(201);
      const roleId: string = created.body.id;
      await call('patch', `/iam/roles/${roleId}`)
        .set(header)
        .send({ name: `${tag} Renamed` })
        .expect(200);
      await call('put', `/iam/roles/${roleId}/permissions`)
        .set(header)
        .send({ permissionIds: [permissionId] })
        .expect(200);
      expect(
        await database.rolePermission.findFirst({ where: { roleId } }),
      ).toMatchObject({ tenantId: tenantIds[1], grantedBy: userIds[0] });
      const details = await call('get', `/iam/roles/${roleId}`)
        .set(header)
        .expect(200);
      expect(details.body.permissionIds).toEqual([permissionId]);
      await call('post', `/iam/members/${userIds[4]}/roles`)
        .set(header)
        .send({ roleIds: [roleId] })
        .expect(201);
      expect(
        await database.userRole.findFirst({ where: { roleId } }),
      ).toMatchObject({ userId: userIds[4], grantedBy: userIds[0] });
      await call('delete', `/iam/roles/${roleId}`).set(header).expect(400);
      await call('get', `/iam/roles/${roleId}`)
        .set('x-tenant-id', tenantIds[0])
        .expect(404);
      await call('post', `/iam/members/${userIds[3]}/roles`)
        .set(header)
        .send({ roleIds: [roleId] })
        .expect(404);
      await call('put', `/iam/roles/${ownerRoleId}/permissions`)
        .set(header)
        .send({ permissionIds: [] })
        .expect(403);
      await call('delete', `/iam/roles/${ownerRoleId}`).set(header).expect(400);
      await call('post', '/iam/roles')
        .set(header)
        .send({ code: 'SUPER_ADMIN', name: 'Forbidden role' })
        .expect(400);
      await call('post', `/iam/members/${userIds[4]}/roles`)
        .set(header)
        .send({ roleIds: [memberRoleId] })
        .expect(201);
      await call('delete', `/iam/roles/${roleId}`).set(header).expect(200);
      expect(
        (await database.role.findUniqueOrThrow({ where: { id: roleId } }))
          .deletedAt,
      ).not.toBeNull();
      await call('get', '/iam/members').set(header).expect(200);
      await call('get', '/iam/roles').set(header).expect(200);
    });

    it('manages members without fabricating actor membership and preserves OWNER/self/tenant protections', async () => {
      await call(
        'patch',
        `/auth/organizations/${tenantIds[1]}/members/${membershipIds[4]}/role`,
      )
        .send({ role: 'ADMIN' })
        .expect(200);
      expect(
        (
          await database.userTenant.findUniqueOrThrow({
            where: { id: membershipIds[4] },
          })
        ).role,
      ).toBe('ADMIN');
      await call(
        'patch',
        `/auth/organizations/${tenantIds[1]}/members/${membershipIds[1]}/role`,
      )
        .send({ role: 'MEMBER' })
        .expect(403);
      await call(
        'delete',
        `/auth/organizations/${tenantIds[1]}/members/${membershipIds[1]}`,
      ).expect(403);
      await call(
        'patch',
        `/auth/organizations/${tenantIds[0]}/members/${membershipIds[0]}/role`,
      )
        .send({ role: 'ADMIN' })
        .expect(400);
      await call(
        'delete',
        `/auth/organizations/${tenantIds[0]}/members/${membershipIds[0]}`,
      ).expect(400);
      await call(
        'delete',
        `/auth/organizations/${tenantIds[0]}/members/${membershipIds[4]}`,
      ).expect(404);
      await call(
        'delete',
        `/auth/organizations/${tenantIds[1]}/members/${membershipIds[4]}`,
      ).expect(200);
      expect(
        (
          await database.userTenant.findUniqueOrThrow({
            where: { id: membershipIds[4] },
          })
        ).deletedAt,
      ).not.toBeNull();
      expect(
        await database.userTenant.count({
          where: { userId: userIds[0], tenantId: tenantIds[1] },
        }),
      ).toBe(0);
    });

    it('reads/revokes/deletes invitation fixtures and enforces resource ownership', async () => {
      const header = { 'x-tenant-id': tenantIds[1] };
      const list = await call('get', '/iam/invitations')
        .set(header)
        .expect(200);
      expect(
        list.body.some((item: { id: string }) => item.id === invitationId),
      ).toBe(true);
      await call('post', `/iam/invitations/${invitationId}/revoke`)
        .set('x-tenant-id', tenantIds[0])
        .expect(404);
      await call('post', `/iam/invitations/${invitationId}/revoke`)
        .set(header)
        .expect(200);
      expect(
        (
          await database.tenantInvitation.findUniqueOrThrow({
            where: { id: invitationId },
          })
        ).status,
      ).toBe('REVOKED');
      await call('delete', `/iam/invitations/${invitationId}`)
        .set(header)
        .expect(200);
      expect(
        (
          await database.tenantInvitation.findUniqueOrThrow({
            where: { id: invitationId },
          })
        ).deletedAt,
      ).not.toBeNull();
    });

    it.runIf(!gatewayUrl)(
      'creates/resends OWNER invitations with the original Super Admin actor (mail stub only)',
      async () => {
        const header = { 'x-tenant-id': tenantIds[1] };
        const created = await call('post', '/iam/invitations')
          .set(header)
          .send({
            email: `${tag}-new@example.test`,
            roleIds: [ownerRoleId],
          })
          .expect(201);
        const id: string = created.body.id;
        expect(
          await database.tenantInvitation.findUnique({ where: { id } }),
        ).toMatchObject({
          inviterId: userIds[0],
          tenantId: tenantIds[1],
          roleIds: [ownerRoleId],
        });
        await call('post', `/iam/invitations/${id}/resend`)
          .set(header)
          .send({})
          .expect(200);
        expect(mail.sendInvitationEmail).toHaveBeenCalledTimes(2);
      },
    );

    it('keeps ordinary users tenant-scoped despite forged headers and denies nonmember switching', async () => {
      const ordinary = token(3);
      await call('post', '/auth/switch-tenant', ordinary)
        .send({ tenantId: tenantIds[1] })
        .expect(401);
      await call('get', `/auth/organizations/${tenantIds[1]}`, ordinary).expect(
        404,
      );
      await call('patch', `/auth/organizations/${tenantIds[0]}`, ordinary)
        .send({ name: 'Not allowed' })
        .expect(403);
      await call('get', '/iam/roles', ordinary)
        .set('x-tenant-id', tenantIds[1])
        .expect(403);
      const profile = await call('get', '/auth/me', ordinary)
        .set('x-tenant-id', tenantIds[1])
        .expect(200);
      expect(profile.body.activeTenant.id).toBe(tenantIds[0]);
      const ownerB = token(2, tenantIds[1]);
      const list = await call('get', '/iam/roles', ownerB)
        .set('x-tenant-id', tenantIds[0])
        .expect(200);
      expect(
        list.body.some((role: { id: string }) => role.id === ownerRoleId),
      ).toBe(true);
    });

    it.each([2, 3, 4])(
      'rejects inactive/deleted target %i at switch and IAM header boundary',
      async (index) => {
        await call('post', '/auth/switch-tenant')
          .send({ tenantId: tenantIds[index] })
          .expect(401);
        await call('get', '/iam/roles')
          .set('x-tenant-id', tenantIds[index])
          .expect(404);
        await call('get', '/iam/invitations')
          .set('x-tenant-id', tenantIds[index])
          .expect(404);
        await call('get', `/auth/organizations/${tenantIds[index]}`).expect(
          404,
        );
      },
    );

    it('rejects malformed headers and unauthenticated calls rather than granting a default tenant', async () => {
      await call('get', '/iam/roles').set('x-tenant-id', 'invalid').expect(400);
      await request(server).get('/api/v1/auth/me').expect(401);
      await request(server)
        .post('/api/v1/auth/switch-tenant')
        .send({ tenantId: tenantIds[1] })
        .expect(401);
      await request(server).get('/api/v1/iam/roles').expect(401);
    });

    it('does not apply set-default/leave to an injected nonmember tenant', async () => {
      await call('post', `/auth/organizations/${tenantIds[1]}/set-default`)
        .send({})
        .expect(404);
      await call('post', `/auth/organizations/${tenantIds[1]}/leave`)
        .send({})
        .expect(404);
      expect(
        await database.userTenant.findUnique({
          where: { id: membershipIds[0] },
        }),
      ).toMatchObject({ role: 'MEMBER', isDefault: true });
    });

    it('invalidates injected access/refresh on target suspension or platform-flag revocation without falling back to A', async () => {
      const switched = await call('post', '/auth/switch-tenant')
        .send({ tenantId: tenantIds[1] })
        .expect(200);
      const cookie = refreshCookie(switched);
      const accessToken: string = switched.body.accessToken;
      try {
        await database.tenant.update({
          where: { id: tenantIds[1] },
          data: { status: 'SUSPENDED' },
        });
        await call('get', '/auth/me', accessToken).expect(401);
        await request(server)
          .post('/api/v1/auth/refresh')
          .set('Cookie', cookie)
          .send({})
          .expect(401);
        await database.tenant.update({
          where: { id: tenantIds[1] },
          data: { status: 'ACTIVE' },
        });
        await database.user.update({
          where: { id: userIds[0] },
          data: { isSuperAdmin: false },
        });
        await call('get', '/auth/me', accessToken).expect(401);
        await request(server)
          .post('/api/v1/auth/refresh')
          .set('Cookie', cookie)
          .send({})
          .expect(401);
        // Membership A remains valid, but it must not silently replace the injected B session.
        const rights = await call('get', '/auth/me/permissions').expect(200);
        expect(rights.body).toMatchObject({
          isSuperAdmin: false,
          permissions: [],
        });
      } finally {
        await database.tenant.update({
          where: { id: tenantIds[1] },
          data: { status: 'ACTIVE' },
        });
        await database.user.update({
          where: { id: userIds[0] },
          data: { isSuperAdmin: true },
        });
      }
    });

    it('preserves existing Super Admin organization deletion and session invalidation', async () => {
      const switched = await call('post', '/auth/switch-tenant')
        .send({ tenantId: tenantIds[5] })
        .expect(200);
      await call('delete', `/auth/organizations/${tenantIds[5]}`).expect(200);
      expect(
        await database.tenant.findUnique({ where: { id: tenantIds[5] } }),
      ).toMatchObject({ status: 'DISABLED', deletedAt: expect.any(Date) });
      await call('get', '/auth/me', switched.body.accessToken).expect(401);
      expect(
        await database.session.count({
          where: {
            userId: userIds[0],
            tenantId: tenantIds[5],
            revokedAt: null,
          },
        }),
      ).toBe(0);
    });
  },
);
