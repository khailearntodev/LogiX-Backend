import request from 'supertest';
import { driverFixture } from './support/driver-fixture.js';

describe('Driver profile tenant and concurrency invariants', () => {
  let f: Awaited<ReturnType<typeof driverFixture>>;
  beforeAll(async () => {
    f = await driverFixture();
  }, 120000);
  afterAll(async () => {
    if (f) await f.close();
  });

  it('keeps cross-tenant rows private and serializes conflicting version updates', async () => {
    const api = request(f.url);
    const auth = `Bearer ${f.token(['master-data:driver:read', 'master-data:driver:manage'])}`;
    const create = {
      code: 'ACCESS-DRV',
      userId: f.userId,
      licenseNumber: 'ACCESS-LICENSE',
      licenseExpiry: '2027-10-25',
    };
    const first = await api
      .post('/api/v1/drivers')
      .set('Authorization', auth)
      .send(create)
      .expect(201);
    const id = first.body.id;
    const otherAuth = `Bearer ${f.token(['master-data:driver:read', 'master-data:driver:manage'], f.otherTenantId)}`;
    await api
      .get(`/api/v1/drivers/${id}`)
      .set('Authorization', otherAuth)
      .expect(404);
    await api
      .patch(`/api/v1/drivers/${id}`)
      .set('Authorization', otherAuth)
      .send({ version: 1, phone: 'forbidden' })
      .expect(404);
    const outcomes = await Promise.all(
      ['one', 'two'].map((phone) =>
        api
          .patch(`/api/v1/drivers/${id}`)
          .set('Authorization', auth)
          .send({ version: 1, phone }),
      ),
    );
    expect(outcomes.map((result) => result.status).sort()).toEqual([200, 409]);
    const stored = await f.master.driver.findUniqueOrThrow({ where: { id } });
    expect(stored.version).toBe(2n);
    expect(stored.tenantId).toBe(f.tenantId);
    expect(stored.userId).toBe(f.userId);
    const admin = `Bearer ${f.token([], f.tenantId, true)}`;
    expect(
      (
        await api
          .get(`/api/v1/drivers/${id}`)
          .set('Authorization', admin)
          .expect(200)
      ).body.id,
    ).toBe(id);
    await api
      .get('/api/v1/drivers')
      .set('Authorization', `Bearer ${f.token([], '', true)}`)
      .expect(401);
    expect(
      await f.master.driver.count({ where: { tenantId: f.otherTenantId } }),
    ).toBe(0);
  }, 60000);
});
