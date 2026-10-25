import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  signInternalServiceToken,
  INTERNAL_SERVICE_TOKEN_HEADER,
} from '@logix/auth';
import { driverFixture } from './support/driver-fixture.js';

describe('Driver Identity eligibility and internal HTTP boundary', () => {
  let f: Awaited<ReturnType<typeof driverFixture>>;
  beforeAll(async () => {
    f = await driverFixture();
  }, 120000);
  afterAll(async () => {
    if (f) await f.close();
  });

  it('filters eligible members before paging, blocks invalid callers, keeps historical names', async () => {
    const identity = request(f.identityUrl);
    await identity.get('/api/v1/internal/driver-users').expect(401);
    const wrong = signInternalServiceToken({
      secret: f.secret,
      service: 'transport-service',
      audience: 'identity-service',
      tenantId: f.tenantId,
      ttlSeconds: 60,
    });
    await identity
      .get('/api/v1/internal/driver-users')
      .set(INTERNAL_SERVICE_TOKEN_HEADER, wrong)
      .expect(401);
    const token = signInternalServiceToken({
      secret: f.secret,
      service: 'master-data-service',
      audience: 'identity-service',
      tenantId: f.tenantId,
      ttlSeconds: 60,
    });
    const list = await identity
      .get('/api/v1/internal/driver-users?pageSize=1')
      .set(INTERNAL_SERVICE_TOKEN_HEADER, token)
      .expect(200);
    expect(list.body).toMatchObject({ total: 1, pageSize: 1 });
    expect(list.body.items[0].id).toBe(f.userId);
    await identity
      .get(`/api/v1/internal/driver-users/${f.otherUserId}/eligibility`)
      .set(INTERNAL_SERVICE_TOKEN_HEADER, token)
      .expect(404);
    await identity
      .post('/api/v1/internal/driver-users/resolve')
      .set(INTERNAL_SERVICE_TOKEN_HEADER, token)
      .send({ userIds: [randomUUID()] })
      .expect(404);

    const roleId = randomUUID();
    const permissionIds: string[] = [];
    try {
      await f.identity.role.create({
        data: {
          id: roleId,
          tenantId: f.tenantId,
          code: 'DRIVER-TEST',
          name: 'Driver test',
        },
      });
      await f.identity.userRole.create({
        data: { tenantId: f.tenantId, userId: f.unqualifiedId, roleId },
      });
      for (const code of ['transport:driver:read', 'transport:driver:update']) {
        const permission = await f.identity.permission.upsert({
          where: { code },
          create: {
            code,
            module: 'transport',
            resource: 'driver',
            action: code.split(':')[2],
            name: code,
          },
          update: {},
        });
        permissionIds.push(permission.id);
        await f.identity.rolePermission.create({
          data: { tenantId: f.tenantId, roleId, permissionId: permission.id },
        });
        const result = await identity
          .get(`/api/v1/internal/driver-users/${f.unqualifiedId}/eligibility`)
          .set(INTERNAL_SERVICE_TOKEN_HEADER, token);
        expect(result.status).toBe(permissionIds.length === 1 ? 404 : 200);
      }
      const auth = `Bearer ${f.token(['master-data:driver:read', 'master-data:driver:manage'])}`;
      const created = await request(f.url)
        .post('/api/v1/drivers')
        .set('Authorization', auth)
        .send({
          code: 'IDENTITY-DRV',
          userId: f.unqualifiedId,
          licenseNumber: 'IDENTITY-LICENSE',
          licenseExpiry: '2027-10-25',
        })
        .expect(201);
      const duplicateCandidates = [
        {
          code: 'IDENTITY-DRV',
          userId: f.userId,
          licenseNumber: 'OTHER-LICENSE',
        },
        {
          code: 'OTHER-DRV',
          userId: f.unqualifiedId,
          licenseNumber: 'OTHER-LICENSE',
        },
        {
          code: 'OTHER-DRV',
          userId: f.userId,
          licenseNumber: 'IDENTITY-LICENSE',
        },
      ];
      for (const candidate of duplicateCandidates) {
        await request(f.url)
          .post('/api/v1/drivers')
          .set('Authorization', auth)
          .send({ ...candidate, licenseExpiry: '2027-10-25' })
          .expect(409);
      }
      expect(
        await f.master.driver.count({ where: { tenantId: f.tenantId } }),
      ).toBe(1);
      await f.identity.user.update({
        where: { id: f.unqualifiedId },
        data: { status: 'DISABLED' },
      });
      const detail = await request(f.url)
        .get(`/api/v1/drivers/${created.body.id}`)
        .set('Authorization', auth)
        .expect(200);
      expect(detail.body.displayName).toBe(`Driver ${f.unqualifiedId}`);
      await request(f.url)
        .post(`/api/v1/drivers/${created.body.id}/disable`)
        .set('Authorization', auth)
        .send({ version: 1 })
        .expect(200);
      await request(f.url)
        .post(`/api/v1/drivers/${created.body.id}/enable`)
        .set('Authorization', auth)
        .send({ version: 2 })
        .expect(404);
      expect(
        (
          await f.master.driver.findUniqueOrThrow({
            where: { id: created.body.id },
          })
        ).status,
      ).toBe('INACTIVE');
    } finally {
      await f.identity.rolePermission.deleteMany({
        where: { roleId, tenantId: f.tenantId },
      });
      await f.identity.userRole.deleteMany({
        where: { roleId, tenantId: f.tenantId },
      });
      await f.identity.role.deleteMany({
        where: { id: roleId, tenantId: f.tenantId },
      });
    }
  }, 60000);
});
