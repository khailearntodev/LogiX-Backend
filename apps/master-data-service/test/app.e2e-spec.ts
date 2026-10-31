import request from 'supertest';
import { driverFixture } from './support/driver-fixture.js';

describe('Master Data application boundary through Gateway', () => {
  let fixture: Awaited<ReturnType<typeof driverFixture>>;
  beforeAll(async () => {
    fixture = await driverFixture();
  }, 120000);
  afterAll(async () => {
    if (fixture) await fixture.close();
  });

  it('boots the owned API and rejects unauthenticated access before returning tenant data', async () => {
    const api = request(fixture.url);
    await api.get('/api/v1/drivers').expect(401);
    const response = await api
      .get('/api/v1/drivers')
      .set(
        'Authorization',
        `Bearer ${fixture.token(['master-data:driver:read'])}`,
      )
      .expect(200);
    expect(response.body).toMatchObject({ items: [], total: 0 });
    await api.get('/api/v1/internal/driver-users').expect(404);
    expect(
      await fixture.master.driver.count({
        where: { tenantId: fixture.tenantId },
      }),
    ).toBe(0);
  }, 60000);
});
