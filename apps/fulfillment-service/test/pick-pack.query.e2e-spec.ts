import 'reflect-metadata';
import { createHmac, randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import {
  SHIPMENT_PERMISSIONS as P,
  SHIPMENT_STATUS as S,
} from '@logix/messaging';
import dotenv from 'dotenv';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import type { Prisma } from '../src/generated/prisma/client.js';

// Explicit opt-in: real Gateway/DB; cleanup is limited to this run's UUIDs.
describe.runIf(
  process.env.PICK_PACK_QUERY_E2E === '1' ||
    process.env.PICK_PACK_STACK_E2E === '1',
)('Pick-and-pack query through Gateway with PostgreSQL', () => {
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const userId = randomUUID();
  const warehouses = [randomUUID(), randomUUID()];
  const createdAt = new Date('2026-01-15T12:00:00.000Z');
  const tag = `qa.pickpack.${randomUUID()}`;
  const statuses = Object.values(S);
  const fixture = (
    index: number,
    tenant: string,
    deletedAt: Date | null = null,
  ) =>
    ({
      id: randomUUID(),
      tenantId: tenant,
      shipmentNumber: `${tag.slice(0, 35)}-${index}`,
      orderId: randomUUID(),
      orderNumber: `${tag.slice(0, 35)}-${index}`,
      warehouseId: warehouses[index % warehouses.length],
      deliveryAddressId: randomUUID(),
      reservationGroupId: randomUUID(),
      customerSnapshot: { code: tag, name: 'QA Pick Pack' },
      deliveryAddressSnapshot: { addressLine: 'QA fixture' },
      warehouseSnapshot: { code: 'QA', name: 'QA warehouse' },
      confirmedOrderVersion: 1n,
      status: statuses[index % statuses.length],
      totalWeight: '1.250',
      totalVolume: '0.100000',
      createdAt,
      deletedAt,
    }) satisfies Prisma.ShipmentCreateManyInput;
  const visible = Array.from({ length: 28 }, (_, i) => fixture(i, tenantId));
  const otherTenant = statuses.map((_, i) => fixture(i, otherTenantId));
  const deleted = [0, 1, 2].map((i) => fixture(i + 28, tenantId, createdAt));
  const fixtures = [...visible, ...otherTenant, ...deleted];
  const ids = fixtures.map((row) => row.id);
  let database: PrismaService | undefined;
  let stack: import('./pick-pack.stack.js').PickPackStack | undefined;
  let gateway: string;
  let secret: string;

  const token = (tenant: string, permissions: string[], expiresIn = 300) => {
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: object) =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    const content = [
      encode({ alg: 'HS256', typ: 'JWT' }),
      encode({
        sub: userId,
        email: `${tag}@example.test`,
        tenantId: tenant,
        permissions,
        iat: now,
        exp: now + expiresIn,
      }),
    ].join('.');
    return `${content}.${createHmac('sha256', secret).update(content).digest('base64url')}`;
  };
  const get = (query = '', tenant = tenantId, permissions = [P.READ]) =>
    request(gateway)
      .get(`/api/v1/shipments${query ? `?${query}` : ''}`)
      .set('Authorization', `Bearer ${token(tenant, permissions)}`);
  const expectedPage = (rows: typeof visible, page: number, pageSize: number) =>
    [...rows]
      .sort((a, b) => b.id.localeCompare(a.id))
      .slice((page - 1) * pageSize, page * pageSize)
      .map(({ id }) => id);
  const pageIds = (body: { items: { id: string }[] }) =>
    body.items.map(({ id }) => id);

  beforeAll(async () => {
    if (process.env.PICK_PACK_STACK_E2E === '1') {
      const { PickPackStack } = await import('./pick-pack.stack.js');
      stack = new PickPackStack();
      await stack.start();
      database = stack.fulfillment;
      gateway = stack.url('api-gateway');
      secret = stack.secret;
    } else {
      dotenv.config({ quiet: true });
      const config = new ConfigService();
      if (config.get<string>('NODE_ENV') === 'production')
        throw new Error('Pick-pack fixtures must not run in production');
      gateway = config.getOrThrow<string>('PICK_PACK_GATEWAY_URL');
      new URL(gateway);
      secret = config.getOrThrow<string>('JWT_SECRET');
      database = new PrismaService(config);
      await database.$connect();
    }
    // Probe before writing fixtures; a missing/stale deployment must fail loudly.
    await get('statuses=PENDING_PICK,PICKING&pageSize=1').expect(200);
    await database.shipment.createMany({ data: fixtures });
    expect(
      await database.shipment.count({
        where: {
          id: { in: ids },
          tenantId: { in: [tenantId, otherTenantId] },
        },
      }),
    ).toBe(fixtures.length);
  }, 240_000);

  afterAll(async () => {
    try {
      if (!database) return;
      const where = {
        id: { in: ids },
        tenantId: { in: [tenantId, otherTenantId] },
      };
      // No history/outbox is expected: this suite exercises reads and rejected writes only.
      const historyCount = await database.shipmentStatusHistory.count({
        where: { shipmentId: { in: ids } },
      });
      const outboxCount = await database.outboxEvent.count({
        where: { aggregateId: { in: ids } },
      });
      await database.shipment.deleteMany({ where });
      expect(await database.shipment.count({ where })).toBe(0);
      expect(historyCount).toBe(0);
      expect(outboxCount).toBe(0);
    } finally {
      if (stack) await stack.close();
      else await database?.$disconnect();
    }
  }, 90_000);

  it('paginates the preparation set before skip/take, with consistent totals and stable tie ordering', async () => {
    const rows = visible.filter(
      (row) => row.status === S.PENDING_PICK || row.status === S.PICKING,
    );
    const received: string[] = [];
    for (const page of [1, 2, 3, 4, 5]) {
      const response = await get(
        `statuses=PENDING_PICK,PICKING&page=${page}&pageSize=2`,
      ).expect(200);
      expect(response.body).toMatchObject({
        total: rows.length,
        page,
        pageSize: 2,
      });
      expect(Object.keys(response.body).sort()).toEqual([
        'items',
        'page',
        'pageSize',
        'total',
      ]);
      expect(pageIds(response.body)).toEqual(expectedPage(rows, page, 2));
      received.push(...pageIds(response.body));
    }
    expect(received).toEqual(expectedPage(rows, 1, rows.length));
    expect(new Set(received).size).toBe(rows.length);
  });

  it('keeps no-status/default pagination backward compatible across more than 20 records', async () => {
    const first = await get().expect(200);
    const second = await get('page=2').expect(200);
    expect(first.body).toMatchObject({ total: 28, page: 1, pageSize: 20 });
    expect(second.body).toMatchObject({ total: 28, page: 2, pageSize: 20 });
    expect([...pageIds(first.body), ...pageIds(second.body)]).toEqual(
      expectedPage(visible, 1, 28),
    );
    expect(typeof first.body.items[0].version).toBe('number');
    expect(first.body.items[0].totalWeight).toBe('1.25');
    expect(first.body.items[0].totalVolume).toBe('0.1');
    expect(first.body.items[0].dispatchIntent).toBeNull();
  });

  describe.each([
    { view: 'all', status: undefined, statuses: undefined, index: 6 },
    {
      view: 'preparation',
      status: undefined,
      statuses: `${S.PENDING_PICK},${S.PICKING}`,
      index: 0,
    },
    {
      view: 'preparation/picking',
      status: S.PICKING,
      statuses: undefined,
      index: 1,
    },
    { view: 'ready', status: S.READY_TO_SHIP, statuses: undefined, index: 2 },
  ])('Phase 4 frontend query: $view', ({ status, statuses, index }) => {
    it.each([false, true])(
      'matches server pagination and total with warehouse/order/local-day filters=%s',
      async (filtered) => {
        const row = visible[index];
        const query = new URLSearchParams({ page: '1', pageSize: '20' });
        if (status) query.set('status', status);
        if (statuses) query.set('statuses', statuses);
        if (filtered) {
          query.set('warehouseId', row.warehouseId);
          query.set('orderId', row.orderId);
          // Same local-day boundaries as useShipmentListQuery, including the final millisecond.
          query.set(
            'createdFrom',
            new Date('2026-01-15T00:00:00').toISOString(),
          );
          query.set(
            'createdTo',
            new Date('2026-01-15T23:59:59.999').toISOString(),
          );
        }
        expect(query.has('status') && query.has('statuses')).toBe(false);
        expect(query.has('view')).toBe(false);
        const rows = visible.filter(
          (candidate) =>
            (!status || candidate.status === status) &&
            (!statuses || statuses.split(',').includes(candidate.status)) &&
            (!filtered || candidate.id === row.id),
        );
        const response = await get(query.toString()).expect(200);
        expect(response.body).toMatchObject({
          total: rows.length,
          page: 1,
          pageSize: 20,
        });
        expect(pageIds(response.body)).toEqual(expectedPage(rows, 1, 20));
        const second = await get(
          new URLSearchParams({
            ...Object.fromEntries(query),
            page: '2',
          }).toString(),
        ).expect(200);
        expect(second.body).toMatchObject({
          total: rows.length,
          page: 2,
          pageSize: 20,
        });
        expect(pageIds(second.body)).toEqual(expectedPage(rows, 2, 20));
      },
    );
  });

  it.each(statuses)('preserves single-status query for %s', async (status) => {
    const rows = visible.filter((row) => row.status === status);
    const response = await get(`status=${status}`).expect(200);
    expect(response.body.total).toBe(rows.length);
    expect(pageIds(response.body)).toEqual(expectedPage(rows, 1, 20));
    if (status === S.READY_TO_SHIP)
      expect(
        response.body.items.every(
          (row: { status: string }) => row.status === S.READY_TO_SHIP,
        ),
      ).toBe(true);
  });

  it('accepts one-token CSV and upper page/pageSize bounds without changing totals', async () => {
    const first = await get('statuses=READY_TO_SHIP&pageSize=100').expect(200);
    expect(first.body).toMatchObject({ total: 4, page: 1, pageSize: 100 });
    expect(pageIds(first.body)).toEqual(
      expectedPage(
        visible.filter((row) => row.status === S.READY_TO_SHIP),
        1,
        100,
      ),
    );
    const beyond = await get(
      'statuses=READY_TO_SHIP&page=21474836&pageSize=100',
    ).expect(200);
    expect(beyond.body).toMatchObject({
      items: [],
      total: 4,
      page: 21474836,
      pageSize: 100,
    });
  });

  it('combines warehouse and inclusive date bounds for both items and total', async () => {
    const date = encodeURIComponent(createdAt.toISOString());
    const rows = visible.filter(
      (row) =>
        row.warehouseId === warehouses[0] &&
        (row.status === S.PENDING_PICK || row.status === S.PICKING),
    );
    const query = `statuses=PENDING_PICK,PICKING&warehouseId=${warehouses[0]}&createdFrom=${date}&createdTo=${date}`;
    const response = await get(query).expect(200);
    expect(response.body.total).toBe(rows.length);
    expect(pageIds(response.body)).toEqual(expectedPage(rows, 1, 20));
    const pagedIds: string[] = [];
    for (const page of [1, 2, 3]) {
      const paged = await get(`${query}&page=${page}&pageSize=2`).expect(200);
      expect(paged.body.total).toBe(rows.length);
      expect(pageIds(paged.body)).toEqual(expectedPage(rows, page, 2));
      pagedIds.push(...pageIds(paged.body));
    }
    expect(pagedIds).toEqual(expectedPage(rows, 1, rows.length));
    const outside = await get(
      `statuses=PENDING_PICK,PICKING&createdFrom=2026-01-16T00:00:00.000Z`,
    ).expect(200);
    expect(outside.body).toMatchObject({ items: [], total: 0 });
    const before = await get(
      'statuses=PENDING_PICK,PICKING&createdTo=2026-01-14T00:00:00.000Z',
    ).expect(200);
    expect(before.body).toMatchObject({ items: [], total: 0 });
  });

  it('combines orderId, warehouse, dates and statuses without broadening the set', async () => {
    const row = visible[0];
    const response = await get(
      `statuses=PENDING_PICK,PICKING&orderId=${row.orderId}&warehouseId=${row.warehouseId}&createdFrom=2026-01-15T00:00:00.000Z&createdTo=2026-01-16T00:00:00.000Z`,
    ).expect(200);
    expect(response.body.total).toBe(1);
    expect(pageIds(response.body)).toEqual([row.id]);
    const missing = await get(
      `statuses=READY_TO_SHIP&orderId=${row.orderId}`,
    ).expect(200);
    expect(missing.body).toMatchObject({ items: [], total: 0 });
  });

  it('isolates both tenants and soft-deleted records on list/detail/update', async () => {
    const response = await get('', otherTenantId).expect(200);
    expect(response.body.total).toBe(otherTenant.length);
    expect(pageIds(response.body)).toEqual(expectedPage(otherTenant, 1, 20));
    await request(gateway)
      .get(`/api/v1/shipments/${visible[0].id}`)
      .set('Authorization', `Bearer ${token(otherTenantId, [P.READ])}`)
      .expect(404);
    await request(gateway)
      .post(`/api/v1/shipments/${visible[0].id}/start-picking`)
      .set('Authorization', `Bearer ${token(otherTenantId, [P.UPDATE])}`)
      .send({ version: 1 })
      .expect(404);
    await request(gateway)
      .get(`/api/v1/shipments/${deleted[0].id}`)
      .set('Authorization', `Bearer ${token(tenantId, [P.READ])}`)
      .expect(404);
  });

  it('rejects missing, invalid and expired credentials with 401', async () => {
    await request(gateway)
      .get('/api/v1/shipments?statuses=PENDING_PICK,PICKING')
      .expect(401);
    await request(gateway)
      .get('/api/v1/shipments')
      .set('Authorization', 'Bearer invalid')
      .expect(401);
    await request(gateway)
      .get('/api/v1/shipments')
      .set('Authorization', `Bearer ${token(tenantId, [P.READ], -1)}`)
      .expect(401);
  });

  it('rejects missing read permission and prevents read-only mutations', async () => {
    await get('statuses=PENDING_PICK,PICKING', tenantId, []).expect(403);
    for (const action of ['start-picking', 'mark-ready']) {
      await request(gateway)
        .post(`/api/v1/shipments/${visible[0].id}/${action}`)
        .set('Authorization', `Bearer ${token(tenantId, [P.READ])}`)
        .send({ version: 1 })
        .expect(403);
    }
    const response = await request(gateway)
      .get(`/api/v1/shipments/${visible[0].id}`)
      .set('Authorization', `Bearer ${token(tenantId, [P.READ])}`)
      .expect(200);
    expect(response.body).toMatchObject({
      status: S.PENDING_PICK,
      version: 1,
    });
  });

  it.each([
    'statuses=',
    'statuses=%2C',
    'statuses=PENDING_PICK,',
    'statuses=,PICKING',
    'statuses=PENDING_PICK,,PICKING',
    'statuses=PENDING_PICK,%20PICKING',
    'statuses=PENDING_PICK,PENDING_PICK',
    'statuses=PENDING_PICK,UNKNOWN',
    'statuses=PENDING_PICK&statuses=PICKING',
    'statuses=PENDING_PICK&statuses=PENDING_PICK',
    'status=READY_TO_SHIP&statuses=PENDING_PICK,PICKING',
    'status=&statuses=PENDING_PICK',
    'status=PENDING_PICK&status=PICKING',
    'status=UNKNOWN',
    'createdFrom=2026-02-01&createdTo=2026-01-01',
    'createdFrom=invalid',
    'page=0',
    'page=1.5',
    'page=21474837',
    'pageSize=0',
    'pageSize=101',
    'warehouseId=invalid',
    'unknown=value',
  ])('rejects malformed query %s with 400', async (query) => {
    await get(query).expect(400);
  });
});
