import { randomUUID } from 'node:crypto';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import request from 'supertest';
import { stableHash } from '../src/trips/trip-serialization.js';
import { tripFixture } from './support/trip-fixture.js';

describe('Draft trips through Gateway, real services and isolated PostgreSQL/Kafka', () => {
  let f: Awaited<ReturnType<typeof tripFixture>>;
  beforeAll(async () => {
    f = await tripFixture();
  }, 120000);
  afterAll(async () => {
    if (f) await f.close();
  }, 60000);

  const permissions = [
    'transport:trip:read',
    'transport:trip:create',
    'transport:trip:update',
    'master-data:warehouse:read',
    'master-data:vehicle:read',
    'master-data:driver:read',
  ];
  const auth = () => `Bearer ${f.driver.token(permissions)}`;
  const api = () => request(f.url);
  const create = async () =>
    (
      await api()
        .post('/api/v1/trips')
        .set('Authorization', auth())
        .send({
          requestId: randomUUID(),
          warehouseId: f.warehouse.id,
          plannedStartAt: '2027-01-02T08:00:00.000Z',
        })
        .expect(201)
    ).body;

  it('persists an unassigned draft, freezes depot and supports exact replay and versioned edits', async () => {
    const body = {
      requestId: randomUUID(),
      warehouseId: f.warehouse.id,
      plannedStartAt: '2027-01-02T08:00:00.000Z',
    };
    const first = await api()
      .post('/api/v1/trips')
      .set('Authorization', auth())
      .send(body)
      .expect(201);
    const id: string = first.body.id;
    expect(first.body).toMatchObject({
      status: 'DRAFT',
      warehouseId: f.warehouse.id,
      driverId: null,
      vehicleId: null,
      vehicleSnapshot: null,
      driverSnapshot: null,
      totalWeight: '0.000',
      totalVolume: '0.000000',
      version: 1,
      shipments: [],
      stops: [],
    });
    const depot = first.body.depotSnapshot;
    await f.driver.master.warehouse.update({
      where: { id: f.warehouse.id },
      data: { addressLine: 'Updated depot, not the frozen trip address' },
    });
    const replay = await api()
      .post('/api/v1/trips')
      .set('Authorization', auth())
      .send(body)
      .expect(201);
    expect(replay.body.id).toBe(id);
    await api()
      .post('/api/v1/trips')
      .set('Authorization', auth())
      .send({ ...body, plannedStartAt: '2027-01-03T08:00:00.000Z' })
      .expect(409);
    const patch = {
      requestId: randomUUID(),
      expectedVersion: 1,
      plannedStartAt: '2027-01-04T08:00:00.000Z',
    };
    const changed = await api()
      .patch(`/api/v1/trips/${id}`)
      .set('Authorization', auth())
      .send(patch)
      .expect(200);
    expect(changed.body.version).toBe(2);
    expect(
      await f.driver.transport.tripOperation.count({ where: { tripId: id } }),
    ).toBe(1);
    await api()
      .patch(`/api/v1/trips/${id}`)
      .set('Authorization', auth())
      .send(patch)
      .expect(409);
    await api()
      .patch(`/api/v1/trips/${id}`)
      .set('Authorization', auth())
      .send({ ...patch, requestId: randomUUID() })
      .expect(409);
    const detail = await api()
      .get(`/api/v1/trips/${id}`)
      .set('Authorization', auth())
      .expect(200);
    expect(detail.body.depotSnapshot).toEqual(depot);
    const list = await api()
      .get(`/api/v1/trips?warehouseId=${f.warehouse.id}&pageSize=1`)
      .set('Authorization', auth())
      .expect(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.total).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(detail.body)).not.toContain('payloadHash');
  });

  it('enforces authentication, permissions, tenant isolation and non-public internal routes', async () => {
    const trip = await create();
    await api().get('/api/v1/trips').expect(401);
    await api()
      .get('/api/v1/trips')
      .set('Authorization', `Bearer ${f.driver.token([])}`)
      .expect(403);
    await api()
      .get(`/api/v1/trips/${trip.id}`)
      .set(
        'Authorization',
        `Bearer ${f.driver.token(permissions, f.driver.otherTenantId)}`,
      )
      .expect(404);
    await api()
      .patch(`/api/v1/trips/${trip.id}`)
      .set('Authorization', `Bearer ${f.driver.token(['transport:trip:read'])}`)
      .send({
        requestId: randomUUID(),
        expectedVersion: 1,
        vehicleId: null,
      })
      .expect(403);
    await api()
      .get('/api/v1/internal/shipments/trip-pool')
      .set('Authorization', auth())
      .expect(404);
  });

  const detail = async (id: string) =>
    (
      await api()
        .get(`/api/v1/trips/${id}`)
        .set('Authorization', auth())
        .expect(200)
    ).body;
  const add = async (
    tripId: string,
    shipments: Array<{ id: string; version: bigint }>,
  ) => {
    const trip = await detail(tripId);
    return api()
      .post(`/api/v1/trips/${tripId}/shipments`)
      .set('Authorization', auth())
      .send({
        requestId: randomUUID(),
        expectedTripVersion: trip.version,
        shipments: shipments.map((shipment) => ({
          shipmentId: shipment.id,
          expectedShipmentVersion: Number(shipment.version),
        })),
      });
  };

  it('claims same-address shipments separately, freezes demand and totals, removes and re-adds without losing history', async () => {
    const trip = await create(),
      addressId = randomUUID();
    const one = await f.seed({
      addressId,
      weight: '1.111',
      volume: '0.001111',
    });
    const two = await f.seed({
      addressId,
      weight: '2.222',
      volume: '0.002222',
    });
    const added = await add(trip.id, [one, two]);
    expect(added.status, JSON.stringify(added.body)).toBe(200);
    const active = await detail(trip.id);
    expect(active.totalWeight).toBe('3.333');
    expect(active.totalVolume).toBe('0.003333');
    expect(active.stops).toHaveLength(2);
    expect(
      active.shipments.filter(
        (item: { state: string }) => item.state === 'ACTIVE',
      ),
    ).toHaveLength(2);
    const stopIds = active.stops.map((stop: { id: string }) => stop.id);
    await f.fulfillment.shipment.update({
      where: { id: one.id },
      data: {
        deliveryAddressSnapshot: {
          addressLine: 'Changed upstream, not trip snapshot',
        },
      },
    });
    expect((await detail(trip.id)).stops).toEqual(active.stops);
    const removed = await api()
      .post(`/api/v1/trips/${trip.id}/shipments/remove`)
      .set('Authorization', auth())
      .send({
        requestId: randomUUID(),
        expectedTripVersion: active.version,
        shipmentIds: [one.id],
      })
      .expect(200);
    const reduced = await detail(trip.id);
    expect(reduced.totalWeight).toBe('2.222');
    expect(reduced.totalVolume).toBe('0.002222');
    expect(
      await f.fulfillment.shipment.findUniqueOrThrow({ where: { id: one.id } }),
    ).toMatchObject({
      assignedTripId: null,
      tripClaimId: null,
      status: 'READY_TO_SHIP',
    });
    const removeReplay = await api()
      .get(`/api/v1/trips/${trip.id}/operations/${removed.body.requestId}`)
      .set('Authorization', auth())
      .expect(200);
    expect(removeReplay.body).toEqual(removed.body);
    await f.fulfillment.shipment.update({
      where: { id: one.id },
      data: { deliveryAddressSnapshot: one.deliveryAddressSnapshot! },
    });
    const currentOne = await f.fulfillment.shipment.findUniqueOrThrow({
      where: { id: one.id },
    });
    const readded = await add(trip.id, [currentOne]);
    expect(readded.status).toBe(200);
    const final = await detail(trip.id);
    expect(final.totalWeight).toBe('3.333');
    expect(final.stops.map((stop: { id: string }) => stop.id).sort()).toEqual(
      stopIds.sort(),
    );
    expect(
      await f.driver.transport.tripShipment.count({
        where: { tripId: trip.id, shipmentId: one.id },
      }),
    ).toBe(2);
    expect(
      await f.driver.transport.tripShipment.count({
        where: { tripId: trip.id, shipmentId: one.id, state: 'ACTIVE' },
      }),
    ).toBe(1);
    expect(
      await f.fulfillment.shipmentTripReceipt.count({
        where: { shipmentId: one.id },
      }),
    ).toBe(3);
  });

  it('filters pool before count/pagination and only one of two trips can claim a shipment', async () => {
    const first = await create(),
      second = await create();
    const shipment = await f.seed();
    const responses = await Promise.all([
      add(first.id, [shipment]),
      add(second.id, [shipment]),
    ]);
    expect(
      responses.filter((response) => response.status === 200),
    ).toHaveLength(1);
    expect(
      responses.filter((response) => response.status === 409),
    ).toHaveLength(1);
    const authoritative = await f.fulfillment.shipment.findUniqueOrThrow({
      where: { id: shipment.id },
    });
    expect([first.id, second.id]).toContain(authoritative.assignedTripId);
    expect(
      await f.driver.transport.tripShipment.count({
        where: { shipmentId: shipment.id, state: 'ACTIVE' },
      }),
    ).toBe(1);
    const ready = await f.seed();
    const pool = await api()
      .get(
        `/api/v1/trips/eligible-shipments?warehouseId=${f.warehouse.id}&page=1&pageSize=1`,
      )
      .set('Authorization', auth())
      .expect(200);
    const expected = await f.fulfillment.shipment.count({
      where: {
        tenantId: f.driver.tenantId,
        warehouseId: f.warehouse.id,
        status: 'READY_TO_SHIP',
        assignedTripId: null,
        deletedAt: null,
      },
    });
    expect(pool.body.total).toBe(expected);
    expect(pool.body.items).toHaveLength(1);
    const all = await api()
      .get(
        `/api/v1/trips/eligible-shipments?warehouseId=${f.warehouse.id}&pageSize=100`,
      )
      .set('Authorization', auth())
      .expect(200);
    const ids = all.body.items.map(
      (item: { shipmentId: string }) => item.shipmentId,
    );
    expect(ids).not.toContain(shipment.id);
    expect(ids).toContain(ready.id);
  });

  it('compensates a partially accepted batch instead of leaving a hidden claim', async () => {
    const trip = await create();
    const accepted = await f.seed(),
      rejected = await f.seed();
    const response = await api()
      .post(`/api/v1/trips/${trip.id}/shipments`)
      .set('Authorization', auth())
      .send({
        requestId: randomUUID(),
        expectedTripVersion: trip.version,
        shipments: [
          { shipmentId: accepted.id, expectedShipmentVersion: 3 },
          { shipmentId: rejected.id, expectedShipmentVersion: 999 },
        ],
      });
    expect(response.status).toBe(409);
    expect(response.body.error).toBe('BUSINESS_RULE_VIOLATION');
    for (const id of [accepted.id, rejected.id]) {
      const shipment = await f.fulfillment.shipment.findUniqueOrThrow({
        where: { id },
      });
      expect(shipment.assignedTripId).toBeNull();
      expect(shipment.tripClaimId).toBeNull();
    }
    expect((await detail(trip.id)).totalWeight).toBe('0.000');
    expect(
      await f.driver.transport.tripShipment.count({
        where: { tripId: trip.id, state: 'ACTIVE' },
      }),
    ).toBe(0);
  });

  it('keeps an unknown claim pending and recovers the exact receipt after a lost HTTP response', async () => {
    const trip = await create(),
      shipment = await f.seed();
    f.fault.dropClaimResponse = true;
    const requestId = randomUUID();
    const body = {
      requestId,
      expectedTripVersion: trip.version,
      shipments: [{ shipmentId: shipment.id, expectedShipmentVersion: 3 }],
    };
    const pending = await api()
      .post(`/api/v1/trips/${trip.id}/shipments`)
      .set('Authorization', auth())
      .send(body)
      .expect(202);
    expect(pending.body.requestId).toBe(requestId);
    expect(
      (
        await f.fulfillment.shipment.findUniqueOrThrow({
          where: { id: shipment.id },
        })
      ).assignedTripId,
    ).toBe(trip.id);
    const pool = await api()
      .get(
        `/api/v1/trips/eligible-shipments?warehouseId=${f.warehouse.id}&pageSize=100`,
      )
      .set('Authorization', auth())
      .expect(200);
    expect(
      pool.body.items.map((item: { shipmentId: string }) => item.shipmentId),
    ).not.toContain(shipment.id);
    await api()
      .patch(`/api/v1/trips/${trip.id}`)
      .set('Authorization', auth())
      .send({
        requestId: randomUUID(),
        expectedVersion: pending.body.version,
        vehicleId: null,
      })
      .expect(409);
    await api()
      .get(`/api/v1/trips/${trip.id}/operations/${requestId}`)
      .set('Authorization', auth())
      .expect(200);
    const complete = await detail(trip.id);
    expect(complete.totalWeight).toBe('1.125');
    expect(
      complete.shipments.filter(
        (item: { state: string }) => item.state === 'ACTIVE',
      ),
    ).toHaveLength(1);
    await api()
      .post(`/api/v1/trips/${trip.id}/shipments`)
      .set('Authorization', auth())
      .send(body)
      .expect(200);
    await api()
      .post(`/api/v1/trips/${trip.id}/shipments`)
      .set('Authorization', auth())
      .send({
        ...body,
        shipments: [{ shipmentId: shipment.id, expectedShipmentVersion: 4 }],
      })
      .expect(409);
    expect(
      await f.fulfillment.shipmentTripReceipt.count({
        where: { shipmentId: shipment.id, operation: 'CLAIM' },
      }),
    ).toBe(1);
  });

  it('binds signed cancel previews to version, releases only trip claims, and replays concurrent confirmation', async () => {
    const trip = await create(),
      shipment = await f.seed();
    expect((await add(trip.id, [shipment])).status).toBe(200);
    const manifest = await detail(trip.id);
    const preview = await api()
      .post(`/api/v1/trips/${trip.id}/cancel-preview`)
      .set('Authorization', auth())
      .send({ expectedVersion: manifest.version })
      .expect(200);
    const body = {
      requestId: randomUUID(),
      expectedVersion: manifest.version,
      previewToken: preview.body.previewToken,
      confirmed: true,
      reason: 'Changed delivery schedule',
    };
    await api()
      .post(`/api/v1/trips/${trip.id}/cancel`)
      .set('Authorization', auth())
      .send({ ...body, reason: '' })
      .expect(400);
    const beforeOrder = await f.orders.salesOrder.findUniqueOrThrow({
      where: { id: shipment.orderId },
    });
    const confirmations = await Promise.all([
      api()
        .post(`/api/v1/trips/${trip.id}/cancel`)
        .set('Authorization', auth())
        .send(body),
      api()
        .post(`/api/v1/trips/${trip.id}/cancel`)
        .set('Authorization', auth())
        .send(body),
    ]);
    expect(
      confirmations.every(({ status }) => [200, 202].includes(status)),
    ).toBe(true);
    const canceled = await api()
      .get(`/api/v1/trips/${trip.id}/operations/${body.requestId}`)
      .set('Authorization', auth())
      .expect(200);
    expect((await detail(trip.id)).status).toBe('CANCELED');
    await api()
      .post(`/api/v1/trips/${trip.id}/cancel`)
      .set('Authorization', auth())
      .send(body)
      .expect(200);
    const releaseReceipts = await f.fulfillment.shipmentTripReceipt.count({
      where: { shipmentId: shipment.id, operation: 'RELEASE' },
    });
    expect(releaseReceipts).toBe(1);
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.now();
    vi.setSystemTime(new Date(now + 301_000));
    try {
      const expiredReplay = await api()
        .post(`/api/v1/trips/${trip.id}/cancel`)
        .set('Authorization', auth())
        .send(body)
        .expect(200);
      expect(expiredReplay.body.status).toBe('COMPLETED');
    } finally {
      vi.useRealTimers();
    }
    expect(
      await f.orders.salesOrder.findUniqueOrThrow({
        where: { id: shipment.orderId },
      }),
    ).toEqual(beforeOrder);
    expect(
      await f.orders.outboxEvent.count({
        where: { tenantId: f.driver.tenantId },
      }),
    ).toBe(0);
    expect(
      await f.fulfillment.shipment.findUniqueOrThrow({
        where: { id: shipment.id },
      }),
    ).toMatchObject({
      status: 'READY_TO_SHIP',
      assignedTripId: null,
      tripClaimId: null,
    });
    expect(
      (
        await api()
          .get(`/api/v1/trips/${trip.id}/operations/${body.requestId}`)
          .set('Authorization', auth())
          .expect(200)
      ).body,
    ).toEqual(canceled.body);
  });

  it('locks Driver identity before assignment and never unlocks after unassignment', async () => {
    const userId = await f.driver.addEligibleUser();
    const manage = `Bearer ${f.driver.token(['master-data:driver:manage', 'master-data:driver:read'])}`;
    const driver = await api()
      .post('/api/v1/drivers')
      .set('Authorization', manage)
      .send({
        code: `DRV-${randomUUID()}`,
        userId,
        licenseNumber: randomUUID(),
        licenseExpiry: '2030-01-01',
      })
      .expect(201);
    const vehicle = await f.driver.master.vehicle.create({
      data: {
        tenantId: f.driver.tenantId,
        code: `VH-${randomUUID()}`,
        licensePlate: randomUUID().slice(0, 20),
        capacityWeight: '100',
        capacityVolume: '10',
        status: 'ACTIVE',
      },
    });
    const trip = await create();
    const assigned = await api()
      .post(`/api/v1/trips/${trip.id}/assignment`)
      .set('Authorization', auth())
      .send({
        requestId: randomUUID(),
        expectedVersion: trip.version,
        driverId: driver.body.id,
        vehicleId: vehicle.id,
      })
      .expect(200);
    expect(assigned.body).toMatchObject({
      driverId: driver.body.id,
      driverUserId: userId,
      vehicleId: vehicle.id,
      driverSnapshot: null,
      vehicleSnapshot: null,
    });
    expect(
      (
        await f.driver.master.driver.findUniqueOrThrow({
          where: { id: driver.body.id },
        })
      ).linkLockedAt,
    ).not.toBeNull();
    expect(
      await f.driver.transport.tripOperation.count({
        where: { tripId: trip.id },
      }),
    ).toBe(2);
    const mixed = await api()
      .patch(`/api/v1/trips/${trip.id}`)
      .set('Authorization', auth())
      .send({
        requestId: randomUUID(),
        expectedVersion: assigned.body.version,
        plannedStartAt: '2027-01-03T08:00:00.000Z',
        driverId: driver.body.id,
      })
      .expect(200);
    expect(
      await f.driver.transport.tripOperation.count({
        where: { tripId: trip.id },
      }),
    ).toBe(3);
    const operationCount = await f.driver.transport.tripOperation.count({
      where: { tripId: trip.id },
    });
    await api()
      .post(`/api/v1/trips/${trip.id}/assignment`)
      .set('Authorization', auth())
      .send({
        requestId: randomUUID(),
        expectedVersion: mixed.body.version,
        driverId: null,
        vehicleId: null,
      })
      .expect(200);
    expect(
      await f.driver.transport.tripOperation.count({
        where: { tripId: trip.id },
      }),
    ).toBe(operationCount);
    expect(
      (
        await f.driver.master.driver.findUniqueOrThrow({
          where: { id: driver.body.id },
        })
      ).linkLockedAt,
    ).not.toBeNull();
    await api()
      .post(`/api/v1/drivers/${driver.body.id}/relink-user/preview`)
      .set('Authorization', manage)
      .send({
        version: driver.body.version,
        expectedUserId: userId,
        userId: await f.driver.addEligibleUser(),
        reason: 'Attempt to change a referenced identity',
      })
      .expect(409);
  });

  it('arbitrates a real first-trip reference against Driver relinking without retaining the wrong user identity', async () => {
    const oldUserId = await f.driver.addEligibleUser();
    const newUserId = await f.driver.addEligibleUser();
    const manage = `Bearer ${f.driver.token(['master-data:driver:manage', 'master-data:driver:read'])}`;
    const createdDriver = await api()
      .post('/api/v1/drivers')
      .set('Authorization', manage)
      .send({
        code: `RACE-${randomUUID()}`,
        userId: oldUserId,
        licenseNumber: randomUUID(),
        licenseExpiry: '2030-01-01',
      })
      .expect(201);
    const driverId: string = createdDriver.body.id;
    const relink = {
      version: createdDriver.body.version,
      expectedUserId: oldUserId,
      userId: newUserId,
      reason: 'Correct identity before any trip reference',
    };
    await api()
      .post(`/api/v1/drivers/${driverId}/relink-user/preview`)
      .set('Authorization', manage)
      .send(relink)
      .expect(200);
    const [tripResponse, relinkResponse] = await Promise.all([
      api().post('/api/v1/trips').set('Authorization', auth()).send({
        requestId: randomUUID(),
        warehouseId: f.warehouse.id,
        plannedStartAt: '2027-01-02T08:00:00.000Z',
        driverId,
      }),
      api()
        .post(`/api/v1/drivers/${driverId}/relink-user`)
        .set('Authorization', manage)
        .send(relink),
    ]);
    expect([201, 409], JSON.stringify(tripResponse.body)).toContain(
      tripResponse.status,
    );
    expect([200, 409], JSON.stringify(relinkResponse.body)).toContain(
      relinkResponse.status,
    );
    const driver = await f.driver.master.driver.findUniqueOrThrow({
      where: { id: driverId },
    });
    if (tripResponse.status === 201) {
      expect(driver.linkLockedAt).not.toBeNull();
      expect((await detail(tripResponse.body.id)).driverUserId).toBe(
        driver.userId,
      );
    } else {
      expect(relinkResponse.status).toBe(200);
      expect(
        await f.driver.transport.deliveryTrip.count({ where: { driverId } }),
      ).toBe(0);
      const retry = await api()
        .post('/api/v1/trips')
        .set('Authorization', auth())
        .send({
          requestId: randomUUID(),
          warehouseId: f.warehouse.id,
          plannedStartAt: '2027-01-02T08:00:00.000Z',
          driverId,
        })
        .expect(201);
      expect(retry.body.driverUserId).toBe(newUserId);
    }
    expect(driver.userId).toBe(
      relinkResponse.status === 200 ? newUserId : oldUserId,
    );
  });

  it.each([false, true])(
    'recovers a persisted crash intent on application restart (upstream already committed: %s)',
    async (claimed) => {
      const trip = await create(),
        shipment = await f.seed();
      const operationId = randomUUID(),
        membershipId = randomUUID(),
        requestId = randomUUID();
      const dto = {
        requestId,
        expectedTripVersion: trip.version,
        shipments: [{ shipmentId: shipment.id, expectedShipmentVersion: 3 }],
      };
      const claimRequest = {
        contractVersion: 1,
        tenantId: f.driver.tenantId,
        requestId: randomUUID(),
        tripId: trip.id,
        shipmentId: shipment.id,
        actorId: f.driver.userId,
        expectedTripVersion: trip.version + 1,
        expectedShipmentVersion: 3,
      };
      const { stableHash } = await import('../src/trips/trip-serialization.js');
      await f.driver.transport.$transaction(async (tx) => {
        await tx.tripOperation.create({
          data: {
            id: operationId,
            tenantId: f.driver.tenantId,
            tripId: trip.id,
            requestId,
            actorId: f.driver.userId,
            kind: 'ADD',
            status: 'PENDING',
            payloadHash: stableHash({ kind: 'ADD', tripId: trip.id, ...dto }),
            payload: {
              request: dto,
              shipmentIds: [shipment.id],
              membershipIds: [membershipId],
              reason: null,
            },
            activeLock: `${f.driver.tenantId}:${trip.id}`,
            nextAttemptAt: new Date(),
            lockedUntil: null,
          },
        });
        await tx.tripShipment.create({
          data: {
            id: membershipId,
            tenantId: f.driver.tenantId,
            tripId: trip.id,
            operationId,
            shipmentId: shipment.id,
            warehouseId: f.warehouse.id,
            state: 'CLAIM_PENDING',
            expectedShipmentVersion: 3n,
            weight: '0.000',
            volume: '0.000000',
            claimRequest,
          },
        });
        await tx.deliveryTrip.update({
          where: { id: trip.id },
          data: { version: { increment: 1 } },
        });
      });
      if (claimed)
        await request(f.fulfillmentUrl)
          .post('/api/v1/internal/shipments/claim')
          .set('x-internal-service-token', f.internalToken())
          .send(claimRequest)
          .expect(200);
      await f.restartTransport();
      await expect
        .poll(
          async () =>
            (
              await f.driver.transport.tripOperation.findUniqueOrThrow({
                where: { id: operationId },
              })
            ).status,
          { timeout: 15000 },
        )
        .toBe('COMPLETED');
      expect((await detail(trip.id)).totalWeight).toBe('1.125');
      expect(
        await f.fulfillment.shipmentTripReceipt.count({
          where: { shipmentId: shipment.id, operation: 'CLAIM' },
        }),
      ).toBe(1);
      await api()
        .post(`/api/v1/trips/${trip.id}/shipments`)
        .set('Authorization', auth())
        .send(dto)
        .expect(200);
    },
  );

  it('consumes real duplicate ShipmentCanceled messages once, releases the mirror and preserves cancellation/history', async () => {
    const trip = await create(),
      shipment = await f.seed();
    expect((await add(trip.id, [shipment])).status).toBe(200);
    const active = await detail(trip.id);
    const canceled = await f.fulfillment.shipment.update({
      where: { id: shipment.id },
      data: { status: 'CANCELED', version: { increment: 1 } },
    });
    const event = {
      eventId: randomUUID(),
      eventType: 'ShipmentCanceled',
      eventVersion: 1,
      occurredAt: new Date().toISOString(),
      producer: 'fulfillment-service',
      tenantId: f.driver.tenantId,
      actorId: null,
      correlationId: randomUUID(),
      causationId: randomUUID(),
      aggregateType: 'Shipment',
      aggregateId: shipment.id,
      aggregateVersion: Number(canceled.version),
      payload: {
        shipmentId: shipment.id,
        orderId: shipment.orderId,
        reservationGroupId: shipment.reservationGroupId,
        warehouseId: shipment.warehouseId,
        dispatchRequestId: null,
        reason: 'ORDER_CANCELED',
        actorId: null,
      },
    };
    const producer = f.broker.kafka.producer();
    await producer.connect();
    try {
      await producer.send({
        topic: f.broker.topic,
        messages: [1, 2].map(() => ({
          key: shipment.id,
          value: JSON.stringify(event),
        })),
      });
    } finally {
      await producer.disconnect();
    }
    await expect
      .poll(async () => (await detail(trip.id)).totalWeight, { timeout: 20000 })
      .toBe('0.000');
    await expect
      .poll(
        async () =>
          (
            await f.fulfillment.shipment.findUniqueOrThrow({
              where: { id: shipment.id },
            })
          ).assignedTripId,
        { timeout: 70000 },
      )
      .toBeNull();
    expect(
      await f.driver.transport.inboxEvent.count({
        where: { tenantId: f.driver.tenantId, eventId: event.eventId },
      }),
    ).toBe(1);
    const final = await detail(trip.id);
    expect(final.stops[0].id).toBe(active.stops[0].id);
    expect(final.stops[0].deletedAt).not.toBeNull();
    expect(
      (
        await f.fulfillment.shipment.findUniqueOrThrow({
          where: { id: shipment.id },
        })
      ).status,
    ).toBe('CANCELED');
  }, 90000);

  it('rejects foreign-warehouse and missing-coordinate snapshots without orphaning upstream claims', async () => {
    for (const shipment of [
      await f.seed({ warehouseId: randomUUID() }),
      await f.seed({ coordinates: false }),
    ]) {
      const trip = await create();
      const result = await add(trip.id, [shipment]);
      expect(result.status).toBe(409);
      expect((await detail(trip.id)).totalWeight).toBe('0.000');
      const upstream = await f.fulfillment.shipment.findUniqueOrThrow({
        where: { id: shipment.id },
      });
      expect(upstream.assignedTripId).toBeNull();
      expect(upstream.tripClaimId).toBeNull();
      expect(
        await f.driver.transport.tripOperation.count({
          where: {
            tripId: trip.id,
            status: { in: ['PENDING', 'COMPENSATING'] },
          },
        }),
      ).toBe(0);
    }
  });

  it.each(['remove', 'cancel'] as const)(
    'recovers an exact %s release after a committed response is lost',
    async (kind) => {
      const trip = await create(),
        shipment = await f.seed();
      expect((await add(trip.id, [shipment])).status).toBe(200);
      const active = await detail(trip.id),
        requestId = randomUUID();
      const preview =
        kind === 'cancel'
          ? await api()
              .post(`/api/v1/trips/${trip.id}/cancel-preview`)
              .set('Authorization', auth())
              .send({ expectedVersion: active.version })
              .expect(200)
          : null;
      const body =
        kind === 'remove'
          ? {
              requestId,
              expectedTripVersion: active.version,
              shipmentIds: [shipment.id],
            }
          : {
              requestId,
              expectedVersion: active.version,
              previewToken: preview!.body.previewToken,
              confirmed: true,
              reason: 'Release response recovery',
            };
      const path = `/api/v1/trips/${trip.id}/${kind === 'remove' ? 'shipments/remove' : 'cancel'}`;
      f.fault.dropReleaseResponse = true;
      await api()
        .post(path)
        .set('Authorization', auth())
        .send(body)
        .expect(202);
      expect(
        (
          await f.fulfillment.shipment.findUniqueOrThrow({
            where: { id: shipment.id },
          })
        ).assignedTripId,
      ).toBeNull();
      const pool = await api()
        .get(
          `/api/v1/trips/eligible-shipments?warehouseId=${f.warehouse.id}&pageSize=100`,
        )
        .set('Authorization', auth())
        .expect(200);
      expect(
        pool.body.items.map((item: { shipmentId: string }) => item.shipmentId),
      ).not.toContain(shipment.id);
      const completed = await api()
        .get(`/api/v1/trips/${trip.id}/operations/${requestId}`)
        .set('Authorization', auth())
        .expect(200);
      expect(completed.body.status).toBe('COMPLETED');
      await api()
        .post(path)
        .set('Authorization', auth())
        .send(body)
        .expect(200);
      expect(
        await f.fulfillment.shipmentTripReceipt.count({
          where: { shipmentId: shipment.id, operation: 'RELEASE' },
        }),
      ).toBe(1);
      expect((await detail(trip.id)).totalWeight).toBe('0.000');
    },
  );

  it('rejects stale, tampered, and expired signed cancel previews without changing a live manifest', async () => {
    const trip = await create(),
      shipment = await f.seed();
    expect((await add(trip.id, [shipment])).status).toBe(200);
    const active = await detail(trip.id);
    const preview = await api()
      .post(`/api/v1/trips/${trip.id}/cancel-preview`)
      .set('Authorization', auth())
      .send({ expectedVersion: active.version })
      .expect(200);
    const changed = await api()
      .patch(`/api/v1/trips/${trip.id}`)
      .set('Authorization', auth())
      .send({
        requestId: randomUUID(),
        expectedVersion: active.version,
        plannedStartAt: '2027-01-05T08:00:00.000Z',
      })
      .expect(200);
    const stale = await api()
      .post(`/api/v1/trips/${trip.id}/cancel`)
      .set('Authorization', auth())
      .send({
        requestId: randomUUID(),
        expectedVersion: changed.body.version,
        previewToken: preview.body.previewToken,
        confirmed: true,
        reason: 'Stale preview must not cancel',
      })
      .expect(422);
    expect(stale.body.error).toBe('BUSINESS_RULE_VIOLATION');
    const expired = await api()
      .post(`/api/v1/trips/${trip.id}/cancel-preview`)
      .set('Authorization', auth())
      .send({ expectedVersion: changed.body.version })
      .expect(200);
    const tamperedPayload = expired.body.previewToken.split('.');
    tamperedPayload[1] = `${tamperedPayload[1][0] === 'a' ? 'b' : 'a'}${tamperedPayload[1].slice(1)}`;
    await api()
      .post(`/api/v1/trips/${trip.id}/cancel`)
      .set('Authorization', auth())
      .send({
        requestId: randomUUID(),
        expectedVersion: changed.body.version,
        previewToken: tamperedPayload.join('.'),
        confirmed: true,
        reason: 'Tampered preview must not cancel',
      })
      .expect(422);
    const claims = jwt.decode(expired.body.previewToken) as JwtPayload;
    const issuedAt = Math.floor(Date.now() / 1000) - 301;
    const expiredToken = jwt.sign(
      { ...claims, iat: issuedAt, exp: issuedAt + 300 },
      process.env.TRIP_CANCEL_PREVIEW_SECRET!,
      { algorithm: 'HS256' },
    );
    const expiredResponse = await api()
      .post(`/api/v1/trips/${trip.id}/cancel`)
      .set('Authorization', auth())
      .send({
        requestId: randomUUID(),
        expectedVersion: changed.body.version,
        previewToken: expiredToken,
        confirmed: true,
        reason: 'Expired preview must not cancel',
      })
      .expect(422);
    expect(expiredResponse.body.error).toBe('BUSINESS_RULE_VIOLATION');
    expect((await detail(trip.id)).status).toBe('DRAFT');
    expect(
      (
        await f.fulfillment.shipment.findUniqueOrThrow({
          where: { id: shipment.id },
        })
      ).assignedTripId,
    ).toBe(trip.id);
  });

  it('replays only exact legacy cancel receipts and rejects receipt-less preview IDs for refresh', async () => {
    const trip = await create();
    const legacyBody = {
      requestId: randomUUID(),
      expectedVersion: trip.version,
      previewId: randomUUID(),
      confirmed: true,
      reason: 'Legacy command already sent before upgrade',
    };
    const unavailable = await api()
      .post(`/api/v1/trips/${trip.id}/cancel`)
      .set('Authorization', auth())
      .send(legacyBody)
      .expect(422);
    expect(unavailable.body.details).toMatchObject({
      code: 'CANCEL_PREVIEW_REFRESH_REQUIRED',
      action: 'refreshPreview',
    });

    const preview = await api()
      .post(`/api/v1/trips/${trip.id}/cancel-preview`)
      .set('Authorization', auth())
      .send({ expectedVersion: trip.version })
      .expect(200);
    const committedRequestId = randomUUID();
    const committed = {
      requestId: committedRequestId,
      expectedVersion: trip.version,
      previewToken: preview.body.previewToken,
      confirmed: true,
      reason: legacyBody.reason,
    };
    const canceled = await api()
      .post(`/api/v1/trips/${trip.id}/cancel`)
      .set('Authorization', auth())
      .send(committed)
      .expect(200);
    const exactLegacyBody = {
      ...legacyBody,
      requestId: committedRequestId,
    };
    await f.driver.transport.tripOperation.update({
      where: {
        tenantId_requestId: {
          tenantId: f.driver.tenantId,
          requestId: committedRequestId,
        },
      },
      data: {
        payloadHash: stableHash({
          kind: 'CANCEL',
          tripId: trip.id,
          ...exactLegacyBody,
        }),
      },
    });
    const replay = await api()
      .post(`/api/v1/trips/${trip.id}/cancel`)
      .set('Authorization', auth())
      .send(exactLegacyBody)
      .expect(200);
    expect(replay.body).toEqual(canceled.body);
  });

  it('rejects invalid pagination, duplicate selections and warehouse mutation instead of silently normalizing them', async () => {
    const trip = await create(),
      shipment = await f.seed();
    await api()
      .get('/api/v1/trips?page=0')
      .set('Authorization', auth())
      .expect(400);
    await api()
      .get(
        `/api/v1/trips/eligible-shipments?warehouseId=${f.warehouse.id}&pageSize=101`,
      )
      .set('Authorization', auth())
      .expect(400);
    await api()
      .patch(`/api/v1/trips/${trip.id}`)
      .set('Authorization', auth())
      .send({
        requestId: randomUUID(),
        expectedVersion: trip.version,
        warehouseId: randomUUID(),
      })
      .expect(400);
    await api()
      .post(`/api/v1/trips/${trip.id}/shipments`)
      .set('Authorization', auth())
      .send({
        requestId: randomUUID(),
        expectedTripVersion: trip.version,
        shipments: [
          { shipmentId: shipment.id, expectedShipmentVersion: 3 },
          { shipmentId: shipment.id, expectedShipmentVersion: 3 },
        ],
      })
      .expect(400);
    await api()
      .post(`/api/v1/trips/${trip.id}/shipments`)
      .set('Authorization', auth())
      .send({
        requestId: randomUUID(),
        expectedTripVersion: trip.version,
        shipments: [],
      })
      .expect(400);
    expect((await detail(trip.id)).version).toBe(trip.version);
    expect(
      await f.fulfillment.shipmentTripReceipt.count({
        where: { shipmentId: shipment.id },
      }),
    ).toBe(0);
  });
});
