import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  INTERNAL_SERVICE_TOKEN_HEADER,
  signInternalServiceToken,
} from '@logix/auth';
import { driverFixture } from './support/driver-fixture.js';

describe('Driver relink: real Gateway / Identity / Transport / PostgreSQL', () => {
  let f: Awaited<ReturnType<typeof driverFixture>>;
  const permissions = ['master-data:driver:read', 'master-data:driver:manage'];
  beforeAll(async () => {
    f = await driverFixture();
  }, 120000);
  afterAll(async () => {
    if (f) await f.close();
  });
  const api = () => request(f.url);
  const auth = () => `Bearer ${f.token(permissions)}`;
  const internalToken = (
    service = 'transport-service',
    audience = 'master-data-service',
    tenantId?: string,
  ) =>
    signInternalServiceToken({
      secret: f.secret,
      service,
      audience,
      tenantId: tenantId ?? f.tenantId,
      ttlSeconds: 60,
    });
  const lock = (id: string, body: object) =>
    request(f.masterUrl)
      .post(`/api/v1/internal/drivers/${id}/link-lock`)
      .set(INTERNAL_SERVICE_TOKEN_HEADER, internalToken())
      .send(body);
  const apply = (id: string, body: object) =>
    api()
      .post(`/api/v1/drivers/${id}/relink-user`)
      .set('Authorization', auth())
      .send(body);
  const preview = (id: string, body: object) =>
    api()
      .post(`/api/v1/drivers/${id}/relink-user/preview`)
      .set('Authorization', auth())
      .send(body);
  async function setup() {
    const previousUserId = await f.addEligibleUser();
    const userId = await f.addEligibleUser();
    const code = randomUUID();
    const created = await api()
      .post('/api/v1/drivers')
      .set('Authorization', auth())
      .send({
        code,
        userId: previousUserId,
        licenseNumber: code,
        licenseExpiry: '2027-10-25',
        phone: '0123456789',
      })
      .expect(201);
    return {
      id: created.body.id as string,
      original: created.body,
      body: {
        version: 1,
        expectedUserId: previousUserId,
        userId,
        reason: 'Sửa liên kết nhầm người dùng',
      },
    };
  }
  const outboxCount = (id: string) =>
    f.master.outboxEvent.count({
      where: { aggregateId: id, tenantId: f.tenantId },
    });
  async function trip(
    driverId: string,
    status: string,
    deletedAt: Date | null = null,
    tenantId = f.tenantId,
  ) {
    await f.transport.deliveryTrip.create({
      data: {
        tenantId,
        tripNumber: randomUUID(),
        warehouseId: randomUUID(),
        vehicleId: randomUUID(),
        driverId,
        depotSnapshot: {},
        status,
        plannedStartAt: new Date(),
        totalWeight: 1,
        totalVolume: 1,
        dispatchVersion: 0,
        deletedAt,
      },
    });
  }

  it('previews without mutation; confirms exact old/new binding and writes atomic trusted-actor audit', async () => {
    const { id, body, original } = await setup();
    const membershipBefore = await f.identity.userTenant.findMany({
      where: { userId: body.userId },
    });
    const shown = await preview(id, {
      ...body,
      reason: `  ${body.reason}  `,
    }).expect(200);
    expect(shown.body).toEqual({
      driverId: id,
      version: 1,
      previousUserId: body.expectedUserId,
      userId: body.userId,
      previousDisplayName: `Driver ${body.expectedUserId}`,
      displayName: `Driver ${body.userId}`,
      reason: body.reason,
    });
    expect(
      (await f.master.driver.findUniqueOrThrow({ where: { id } })).version,
    ).toBe(1n);
    expect(await outboxCount(id)).toBe(0);
    const correlationId = randomUUID();
    const result = await api()
      .post(`/api/v1/drivers/${id}/relink-user`)
      .set('Authorization', auth())
      .set('x-correlation-id', correlationId)
      .send(body)
      .expect(200);
    expect(result.body).toMatchObject({
      id,
      code: original.code,
      userId: body.userId,
      displayName: `Driver ${body.userId}`,
      licenseNumber: original.licenseNumber,
      licenseExpiry: original.licenseExpiry,
      phone: original.phone,
      status: original.status,
      version: 2,
    });
    const events = await f.master.outboxEvent.findMany({
      where: { aggregateId: id },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tenantId: f.tenantId,
      eventType: 'DriverUserRelinked',
      eventVersion: 1,
      aggregateVersion: 2n,
      correlationId,
      publishedAt: null,
      payload: {
        actorId: f.userId,
        actorType: 'USER',
        tenantId: f.tenantId,
        action: 'driver.relink-user',
        entityId: id,
        outcome: 'SUCCESS',
        beforeData: { userId: body.expectedUserId, version: 1 },
        afterData: { userId: body.userId, version: 2 },
        metadata: { reason: body.reason },
      },
    });
    expect(f.userId).not.toBe(body.userId);
    expect(
      await f.identity.userTenant.findMany({ where: { userId: body.userId } }),
    ).toEqual(membershipBefore);
    await apply(id, body).expect(409);
    expect(await outboxCount(id)).toBe(1);
  }, 60000);

  it('does not treat preview as authority when target eligibility or Driver version changes', async () => {
    const { id, body } = await setup();
    await preview(id, body).expect(200);
    await f.identity.userTenant.updateMany({
      where: { tenantId: f.tenantId, userId: body.userId },
      data: { status: 'SUSPENDED' },
    });
    await apply(id, body).expect(404);
    await f.identity.userTenant.updateMany({
      where: { tenantId: f.tenantId, userId: body.userId },
      data: { status: 'ACTIVE' },
    });
    await preview(id, body).expect(200);
    await api()
      .patch(`/api/v1/drivers/${id}`)
      .set('Authorization', auth())
      .send({ version: 1, phone: 'changed' })
      .expect(200);
    const denied = await apply(id, body).expect(409);
    expect(denied.body.error).toBe('CONCURRENCY_CONFLICT');
    expect(
      (await f.master.driver.findUniqueOrThrow({ where: { id } })).userId,
    ).toBe(body.expectedUserId);
    expect(await outboxCount(id)).toBe(0);
  }, 60000);

  it('rejects anonymous/read-only/tenantless and forged actor requests; Super Admin cannot bypass usage', async () => {
    const { id, body } = await setup();
    for (const suffix of ['relink-user/preview', 'relink-user']) {
      const path = `/api/v1/drivers/${id}/${suffix}`;
      await api().post(path).send(body).expect(401);
      await api()
        .post(path)
        .set('Authorization', `Bearer ${f.token(['master-data:driver:read'])}`)
        .send(body)
        .expect(403);
      await api()
        .post(path)
        .set('Authorization', `Bearer ${f.token(permissions, '')}`)
        .send(body)
        .expect(401);
      await api()
        .post(path)
        .set('Authorization', auth())
        .send({ ...body, actorId: body.userId })
        .expect(400);
      await api()
        .post(path)
        .set('Authorization', `Bearer ${f.token(permissions, f.otherTenantId)}`)
        .send(body)
        .expect(404);
    }
    await trip(id, 'DRAFT');
    const denied = await api()
      .post(`/api/v1/drivers/${id}/relink-user`)
      .set('Authorization', `Bearer ${f.token(permissions, f.tenantId, true)}`)
      .send(body)
      .expect(409);
    expect(denied.body.error).toBe('DRIVER_LINK_LOCKED');
    expect(denied.body.details.reason).toBe('USED');
    expect(await outboxCount(id)).toBe(0);
  }, 60000);

  it('rejects stale and wrong-old binding, unchanged, duplicate, cross-tenant, inactive and unqualified targets', async () => {
    const { id, body } = await setup();
    const duplicateUser = await f.addEligibleUser();
    await f.master.driver.create({
      data: {
        tenantId: f.tenantId,
        code: randomUUID(),
        userId: duplicateUser,
        licenseNumber: randomUUID(),
        licenseExpiry: new Date('2027-10-25'),
        status: 'ACTIVE',
      },
    });
    const inactiveUser = await f.addEligibleUser();
    await f.identity.user.update({
      where: { id: inactiveUser },
      data: { status: 'DISABLED' },
    });
    for (const suffix of ['relink-user/preview', 'relink-user']) {
      const send = (patch: object, status: number) =>
        api()
          .post(`/api/v1/drivers/${id}/${suffix}`)
          .set('Authorization', auth())
          .send({ ...body, ...patch })
          .expect(status);
      expect((await send({ version: 2 }, 409)).body.error).toBe(
        'CONCURRENCY_CONFLICT',
      );
      expect(
        (await send({ expectedUserId: randomUUID() }, 409)).body.error,
      ).toBe('CONCURRENCY_CONFLICT');
      expect(
        (await send({ userId: body.expectedUserId }, 409)).body.error,
      ).toBe('DRIVER_LINK_UNCHANGED');
      await send({ userId: duplicateUser }, 409);
      await send({ userId: f.otherUserId }, 404);
      await send({ userId: f.unqualifiedId }, 404);
      await send({ userId: inactiveUser }, 404);
      for (const reason of ['', '  ', null, 'x'.repeat(1001)])
        await send({ reason }, 400);
      await send({ version: '1' }, 400);
    }
    expect(
      (await f.master.driver.findUniqueOrThrow({ where: { id } })).userId,
    ).toBe(body.expectedUserId);
    expect(await outboxCount(id)).toBe(0);
  }, 60000);

  it.each([
    ['DRAFT', null],
    ['CANCELED', null],
    ['COMPLETED', new Date()],
  ])(
    'blocks every historical %s reference including soft-deleted records',
    async (status, deletedAt) => {
      const { id, body } = await setup();
      // Preview is not a bypass token: a trip can appear before confirmation.
      await preview(id, body).expect(200);
      await trip(id, status, deletedAt);
      for (const result of [await preview(id, body), await apply(id, body)]) {
        expect(result.status).toBe(409);
        expect(result.body.error).toBe('DRIVER_LINK_LOCKED');
      }
      expect(await outboxCount(id)).toBe(0);
    },
    60000,
  );

  it('Transport usage endpoint is signed/allowlisted, tenant-scoped and ignores no historical filters', async () => {
    const { id, body } = await setup();
    const path = `/api/v1/internal/drivers/${id}/usage`;
    await trip(id, 'DRAFT', null, f.otherTenantId);
    await request(f.transportUrl).get(path).expect(401);
    await request(f.transportUrl)
      .get(path)
      .set(
        INTERNAL_SERVICE_TOKEN_HEADER,
        internalToken('identity-service', 'transport-service'),
      )
      .expect(401);
    const usage = await request(f.transportUrl)
      .get(path)
      .set(
        INTERNAL_SERVICE_TOKEN_HEADER,
        internalToken('master-data-service', 'transport-service'),
      )
      .expect(200);
    expect(usage.body).toEqual({
      tenantId: f.tenantId,
      driverId: id,
      used: false,
    });
    await apply(id, body).expect(200);
    await api().get(path).expect(404);
  }, 60000);

  it('requires signed Transport caller and exact binding for permanent idempotent lock; no clear after cancellation', async () => {
    const { id, body } = await setup();
    const path = `/api/v1/internal/drivers/${id}/link-lock`;
    const binding = {
      version: body.version,
      expectedUserId: body.expectedUserId,
    };
    await request(f.masterUrl).post(path).send(binding).expect(401);
    await request(f.masterUrl)
      .post(path)
      .set(INTERNAL_SERVICE_TOKEN_HEADER, internalToken('identity-service'))
      .send(binding)
      .expect(401);
    await request(f.masterUrl)
      .post(path)
      .set(
        INTERNAL_SERVICE_TOKEN_HEADER,
        internalToken(
          'transport-service',
          'master-data-service',
          f.otherTenantId,
        ),
      )
      .send(binding)
      .expect(404);
    await lock(id, { ...binding, expectedUserId: randomUUID() }).expect(409);
    const first = await lock(id, binding).expect(200);
    expect(first.body).toEqual({
      driverId: id,
      userId: body.expectedUserId,
      version: 1,
    });
    const lockedAt = (
      await f.master.driver.findUniqueOrThrow({ where: { id } })
    ).linkLockedAt;
    expect(lockedAt).toBeInstanceOf(Date);
    expect((await lock(id, binding).expect(200)).body).toEqual(first.body);
    expect(
      (await f.master.driver.findUniqueOrThrow({ where: { id } })).linkLockedAt,
    ).toEqual(lockedAt);
    // A failed or canceled trip insert does not undo the successful lock.
    const denied = await apply(id, body).expect(409);
    expect(denied.body.error).toBe('DRIVER_LINK_LOCKED');
    expect(await outboxCount(id)).toBe(0);
    await api().post(path).send(binding).expect(404);
  }, 60000);

  it('serializes lock winning after history query, and rejects stale lock when relink wins', async () => {
    const { id, body } = await setup();
    const originalUsed = f.transportClient.used.bind(f.transportClient);
    let resume!: () => void, observed!: () => void;
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const checked = new Promise<void>((resolve) => {
      observed = resolve;
    });
    const spy = vi
      .spyOn(f.transportClient, 'used')
      .mockImplementationOnce(async (tenant, driver) => {
        const result = await originalUsed(tenant, driver);
        observed();
        await paused;
        return result;
      });
    try {
      const pending = apply(id, body).then((result) => result);
      await checked;
      await lock(id, {
        version: 1,
        expectedUserId: body.expectedUserId,
      }).expect(200);
      resume();
      const denied = await pending;
      expect(denied.status).toBe(409);
      expect(denied.body.error).toBe('DRIVER_LINK_LOCKED');
      expect(await outboxCount(id)).toBe(0);
    } finally {
      resume();
      spy.mockRestore();
    }
    const next = await setup();
    await apply(next.id, next.body).expect(200);
    await lock(next.id, {
      version: 1,
      expectedUserId: next.body.expectedUserId,
    }).expect(409);
    const current = await f.master.driver.findUniqueOrThrow({
      where: { id: next.id },
    });
    expect(current).toMatchObject({
      userId: next.body.userId,
      version: 2n,
      linkLockedAt: null,
    });
    await lock(next.id, {
      version: 2,
      expectedUserId: next.body.userId,
    }).expect(200);
  }, 60000);

  it('serializes competing relinks and duplicate-user writes with exactly one audit success', async () => {
    const first = await setup(),
      second = await setup();
    const responses = await Promise.all([
      apply(first.id, first.body),
      apply(first.id, first.body),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await outboxCount(first.id)).toBe(1);
    const target = await f.addEligibleUser();
    const a = await setup();
    const duplicate = await Promise.all([
      apply(a.id, { ...a.body, userId: target }),
      apply(second.id, { ...second.body, userId: target }),
    ]);
    expect(duplicate.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await outboxCount(a.id)) + (await outboxCount(second.id))).toBe(1);
  }, 60000);

  it('allows only one winner when relink and permanent lock start concurrently', async () => {
    const { id, body } = await setup();
    const [relinked, locked] = await Promise.all([
      apply(id, body),
      lock(id, { version: body.version, expectedUserId: body.expectedUserId }),
    ]);
    expect([relinked.status, locked.status].sort()).toEqual([200, 409]);
    const current = await f.master.driver.findUniqueOrThrow({ where: { id } });
    if (locked.status === 200) {
      expect(current).toMatchObject({
        userId: body.expectedUserId,
        version: 1n,
      });
      expect(current.linkLockedAt).toBeInstanceOf(Date);
      expect(relinked.body.error).toBe('DRIVER_LINK_LOCKED');
      expect(await outboxCount(id)).toBe(0);
    } else {
      expect(current).toMatchObject({
        userId: body.userId,
        version: 2n,
        linkLockedAt: null,
      });
      expect(locked.body.error).toBe('CONCURRENCY_CONFLICT');
      expect(await outboxCount(id)).toBe(1);
    }
  }, 60000);

  it('rolls back Driver/version when durable audit insertion fails', async () => {
    const { id, body } = await setup();
    const before = await f.master.driver.findUniqueOrThrow({ where: { id } });
    const name = `test_audit_failure_${randomUUID().replaceAll('-', '')}`;
    // All identifiers are generated UUIDs in the runner-owned isolated database.
    await f.master.$executeRawUnsafe(
      `ALTER TABLE master_data.outbox_events ADD CONSTRAINT "${name}" CHECK (tenant_id <> '${f.tenantId}'::uuid) NOT VALID`,
    );
    try {
      await apply(id, body).expect(500);
      expect(
        await f.master.driver.findUniqueOrThrow({ where: { id } }),
      ).toEqual(before);
      expect(await outboxCount(id)).toBe(0);
    } finally {
      await f.master.$executeRawUnsafe(
        `ALTER TABLE master_data.outbox_events DROP CONSTRAINT "${name}"`,
      );
    }
  }, 60000);

  it('fails closed when Transport is unavailable, leaving Driver and outbox unchanged', async () => {
    const { id, body } = await setup();
    const before = await f.master.driver.findUniqueOrThrow({ where: { id } });
    await f.stopTransport();
    await preview(id, body).expect(503);
    await apply(id, body).expect(503);
    expect(await f.master.driver.findUniqueOrThrow({ where: { id } })).toEqual(
      before,
    );
    expect(await outboxCount(id)).toBe(0);
  }, 60000);
});
