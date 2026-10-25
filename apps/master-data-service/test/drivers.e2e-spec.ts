import request from 'supertest';
import { driverFixture } from './support/driver-fixture.js';

describe('Driver management through real Gateway / Identity / PostgreSQL', () => {
  let f: Awaited<ReturnType<typeof driverFixture>>;
  beforeAll(async () => {
    f = await driverFixture();
  }, 120000);
  afterAll(async () => {
    if (f) await f.close();
  });
  const read = 'master-data:driver:read',
    manage = 'master-data:driver:manage';

  it('creates, reads, updates, disables/enables and rejects stale writes without rebinding user', async () => {
    const api = request(f.url),
      auth = `Bearer ${f.token([read, manage])}`;
    const eligible = await api
      .get('/api/v1/drivers/eligible-users')
      .set('Authorization', auth)
      .expect(200);
    await api
      .get('/api/v1/drivers/eligible-users?status=INACTIVE')
      .set('Authorization', auth)
      .expect(400);
    expect(eligible.body.items.map((u: { id: string }) => u.id)).toEqual([
      f.userId,
    ]);
    const data = {
      code: 'DRV-ONE',
      userId: f.userId,
      licenseNumber: 'LICENSE-ONE',
      licenseExpiry: '2027-10-25',
    };
    const created = await api
      .post('/api/v1/drivers')
      .set('Authorization', auth)
      .send(data)
      .expect(201);
    const id = created.body.id;
    expect(created.body).toMatchObject({
      ...data,
      tenantId: f.tenantId,
      version: 1,
      status: 'ACTIVE',
    });
    expect(created.body.displayName).toBe(`Driver ${f.userId}`);
    expect(
      await f.master.driver.count({ where: { id, tenantId: f.tenantId } }),
    ).toBe(1);
    await api
      .post('/api/v1/drivers')
      .set('Authorization', auth)
      .send(data)
      .expect(409);
    const changed = await api
      .patch(`/api/v1/drivers/${id}`)
      .set('Authorization', auth)
      .send({ version: 1, phone: '0123456789' })
      .expect(200);
    expect(changed.body.version).toBe(2);
    await api
      .patch(`/api/v1/drivers/${id}`)
      .set('Authorization', auth)
      .send({ version: 1, phone: 'old' })
      .expect(409);
    await api
      .patch(`/api/v1/drivers/${id}`)
      .set('Authorization', auth)
      .send({ version: 2, userId: f.otherUserId })
      .expect(400);
    await api
      .post(`/api/v1/drivers/${id}/disable`)
      .set('Authorization', auth)
      .send({ version: 2 })
      .expect(200);
    const disabled = await api
      .get(`/api/v1/drivers/${id}`)
      .set('Authorization', auth)
      .expect(200);
    expect(disabled.body).toMatchObject({
      status: 'INACTIVE',
      version: 3,
      userId: f.userId,
    });
    await api
      .post(`/api/v1/drivers/${id}/enable`)
      .set('Authorization', auth)
      .send({ version: 3 })
      .expect(200);
    const final = await api
      .get(`/api/v1/drivers/${id}`)
      .set('Authorization', auth)
      .expect(200);
    expect(final.body).toMatchObject({ status: 'ACTIVE', version: 4 });
    expect(
      (
        await api
          .get('/api/v1/drivers?q=DRV-ONE&pageSize=1')
          .set('Authorization', auth)
          .expect(200)
      ).body.total,
    ).toBe(1);
  }, 60000);

  it('fails closed for anonymous, read-only, cross-tenant and fake privilege requests', async () => {
    const api = request(f.url);
    await api.get('/api/v1/drivers').expect(401);
    await api
      .get('/api/v1/drivers')
      .set('Authorization', `Bearer ${f.token([])}`)
      .set('isSuperAdmin', 'true')
      .expect(403);
    const body = {
      code: 'DENIED',
      userId: f.userId,
      licenseNumber: 'DENIED',
      licenseExpiry: '2027-10-25',
    };
    await api
      .post('/api/v1/drivers')
      .set('Authorization', `Bearer ${f.token([read])}`)
      .send(body)
      .expect(403);
    await api
      .post('/api/v1/drivers')
      .set('Authorization', `Bearer ${f.token([manage])}`)
      .send({ ...body, userId: f.otherUserId })
      .expect(404);
    await api
      .post('/api/v1/drivers')
      .set('Authorization', `Bearer ${f.token([manage])}`)
      .send({ ...body, userId: f.unqualifiedId })
      .expect(404);
    const list = await api
      .get('/api/v1/drivers')
      .set('Authorization', `Bearer ${f.token([read], f.otherTenantId)}`)
      .expect(200);
    expect(list.body.items).toEqual([]);
    expect(
      await f.master.driver.count({
        where: { code: 'DENIED', tenantId: f.tenantId },
      }),
    ).toBe(0);
    await api.get('/api/v1/internal/driver-users').expect(404);
  }, 60000);
});
