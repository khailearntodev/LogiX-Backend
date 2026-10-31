import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { z } from 'zod';
import {
  KafkaEventConsumer, KafkaProducerService, OutboxRelay, PrismaOutboxStore,
  batchDispatchGrantRequestSchema, tripDispatchOperationSchema, tripDispatchPreviewSchema,
  deliveryResultEventSchema, tripDispatchedEventV2Schema,
  type DomainEventEnvelope,
} from '@logix/messaging';
import { ServiceId } from '@logix/common';
import { ShipmentIssueService } from '../../inventory-service/src/inventory/services/shipment-issue.service.js';
import { StockMovementService } from '../../inventory-service/src/inventory/services/stock-movement.service.js';
import { TripDispatchService } from '../src/dispatch/trip-dispatch.service.js';
import { tripFixture } from './support/trip-fixture.js';

const tripSchema = z.object({
  id: z.string().uuid(), version: z.number().int(), status: z.string(),
  stops: z.array(z.object({ id: z.string().uuid() }).passthrough()),
}).passthrough();
type Trip = z.infer<typeof tripSchema>;

describe('Phase 4 real Gateway / owner PostgreSQL / Kafka dispatch', () => {
  let f: Awaited<ReturnType<typeof tripFixture>>;
  let producer: KafkaProducerService;
  let issueConsumer: KafkaEventConsumer;
  let fulfillmentRelay: OutboxRelay;
  let issue: ShipmentIssueService;
  const observed: DomainEventEnvelope[] = [];
  const permissions = [
    'transport:trip:read', 'transport:trip:create', 'transport:trip:update', 'transport:trip:dispatch',
    'transport:route:read', 'transport:route:approve',
    'master-data:warehouse:read', 'master-data:vehicle:read', 'master-data:vehicle:manage',
    'master-data:driver:read', 'master-data:driver:manage',
  ];
  const auth = (extra: Record<string, unknown> = {}) => `Bearer ${jwt.sign({
    sub: f.driver.userId, email: 'qa.dispatch@example.test', tenantId: f.driver.tenantId,
    permissions, isSuperAdmin: false, ...extra,
  }, f.driver.secret, { expiresIn: '10m' })}`;
  const api = () => request(f.url);
  const driverAuth = (userId: string) =>
    auth({
      sub: userId,
      permissions: ['transport:driver:read', 'transport:driver:update'],
    });
  const eventually = async (assertion: () => Promise<void>) => {
    let failure: unknown;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await assertion(); return; } catch (error) { failure = error; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw failure;
  };
  beforeAll(async () => {
    f = await tripFixture({ dispatch: true });
    if (!f.inventory) throw new Error('Isolated Inventory was not started');
    issue = new ShipmentIssueService(f.inventory, new StockMovementService(f.inventory));
    producer = new KafkaProducerService(f.broker.kafka);
    await producer.onModuleInit();
    issueConsumer = new KafkaEventConsumer(f.broker.kafka, f.broker.topic, `phase4-issue-${randomUUID()}`, async (event) => {
      observed.push(event);
      await issue.handle(event);
    });
    await issueConsumer.onModuleInit();
    fulfillmentRelay = new OutboxRelay(new PrismaOutboxStore(f.fulfillment, 'fulfillment', ServiceId.FULFILLMENT_SERVICE, 30000),
      producer, { topic: f.broker.topic, intervalMs: 100, batchSize: 100, retryBaseMs: 100, retryMaxMs: 1000 });
  }, 120000);
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    if (issueConsumer) await issueConsumer.onModuleDestroy();
    if (producer) await producer.onModuleDestroy();
    if (f) await f.close();
  }, 60000);

  const detail = async (tripId: string) =>
    tripSchema.parse((await api().get(`/api/v1/trips/${tripId}`).set('Authorization', auth()).expect(200)).body);
  const approved = async (count = 2) => {
    const driverUserId = await f.driver.addEligibleUser();
    const driver = (await api().post('/api/v1/drivers').set('Authorization', auth()).send({
      code: `D-${randomUUID()}`, userId: driverUserId,
      licenseNumber: `L-${randomUUID()}`, licenseExpiry: '2030-12-31',
    }).expect(201)).body as { id: string };
    const vehicle = (await api().post('/api/v1/vehicles').set('Authorization', auth()).send({
      code: `V-${randomUUID()}`, licensePlate: `QA-${randomUUID().slice(0, 12)}`,
      capacityWeight: '100.000', capacityVolume: '10.000000',
    }).expect(201)).body as { id: string };
    let trip = tripSchema.parse((await api().post('/api/v1/trips').set('Authorization', auth()).send({
      requestId: randomUUID(), warehouseId: f.warehouse.id, plannedStartAt: '2027-01-02T08:00:00.000Z',
      vehicleId: vehicle.id, driverId: driver.id,
    }).expect(201)).body);
    const shipments = [];
    for (let index = 0; index < count; index++) {
      const shipment = await f.seed();
      await f.orders.salesOrder.update({ where: { id: shipment.orderId }, data: { status: 'READY_TO_SHIP' } });
      if (!f.inventory) throw new Error('Inventory unavailable');
      const item = await f.fulfillment.shipmentItem.findFirstOrThrow({ where: { shipmentId: shipment.id } });
      const balance = await f.inventory.inventoryBalance.create({
        data: { tenantId: f.driver.tenantId, warehouseId: shipment.warehouseId, productId: item.productId,
          onHandQuantity: '20.000', reservedQuantity: item.quantity.toString(), lowStockThreshold: '0.000' },
      });
      await f.inventory.reservationGroup.create({
        data: {
          id: shipment.reservationGroupId, tenantId: f.driver.tenantId, orderId: shipment.orderId,
          warehouseId: shipment.warehouseId, status: 'ACTIVE', orderVersion: 2n, idempotencyKey: randomUUID(),
          reservations: { create: {
            tenantId: f.driver.tenantId, orderId: shipment.orderId, orderLineId: item.orderLineId,
            balanceId: balance.id, warehouseId: shipment.warehouseId, productId: item.productId,
            quantity: item.quantity.toString(), status: 'ACTIVE',
          } },
        },
      });
      shipments.push(shipment);
    }
    await api().post(`/api/v1/trips/${trip.id}/shipments`).set('Authorization', auth()).send({
      requestId: randomUUID(), expectedTripVersion: trip.version,
      shipments: shipments.map((item) => ({ shipmentId: item.id, expectedShipmentVersion: Number(item.version) })),
    }).expect(200);
    trip = await detail(trip.id);
    const plan = (await api().post(`/api/v1/trips/${trip.id}/route-plans/manual`).set('Authorization', auth()).send({
      requestId: randomUUID(), expectedTripVersion: trip.version, orderedStopIds: trip.stops.map((stop) => stop.id),
    }).expect(201)).body as { id: string; planVersion: number; inputHash: string };
    const selection = { expectedVersion: trip.version, planId: plan.id, planVersion: plan.planVersion, inputHash: plan.inputHash };
    const preview = (await api().post(`/api/v1/trips/${trip.id}/route-approval-preview`).set('Authorization', auth()).send(selection).expect(200)).body as { previewToken: string };
    await api().post(`/api/v1/trips/${trip.id}/approve-route`).set('Authorization', auth())
      .send({ ...selection, requestId: randomUUID(), confirmed: true, previewToken: preview.previewToken }).expect(200);
    return {
      trip: await detail(trip.id),
      shipments,
      vehicleId: vehicle.id,
      driverId: driver.id,
      driverUserId,
    };
  };
  const command = async (trip: Trip) => {
    const preview = tripDispatchPreviewSchema.parse((await api().post(`/api/v1/trips/${trip.id}/dispatch-preview`)
      .set('Authorization', auth()).send({ version: trip.version }).expect(200)).body);
    return { requestId: randomUUID(), version: trip.version, previewToken: preview.previewToken, confirmed: true as const };
  };
  const dispatch = (trip: Trip, body: Awaited<ReturnType<typeof command>>) =>
    api().post(`/api/v1/trips/${trip.id}/dispatch`).set('Authorization', auth()).send(body);
  const operation = async (trip: Trip, requestId: string) =>
    tripDispatchOperationSchema.parse((await api().get(`/api/v1/trips/${trip.id}/operations/${requestId}`)
      .set('Authorization', auth()).expect(200)).body);

  it('serves Driver trips, commits terminal results once, completes/releases, and supports Super Admin action preview', async () => {
    const { trip, vehicleId, driverId, driverUserId } = await approved(2);
    await dispatch(trip, await command(trip)).expect(200);
    const driverToken = driverAuth(driverUserId);
    await api().get('/api/v1/driver/trips').expect(401);
    const list = await api()
      .get('/api/v1/driver/trips?scope=current&page=1&pageSize=20')
      .set('Authorization', driverToken)
      .expect(200);
    expect(list.body.items.map((item: { tripId: string }) => item.tripId)).toContain(trip.id);
    await api()
      .get(`/api/v1/driver/trips?scope=current&driverId=${driverId}`)
      .set('Authorization', driverToken)
      .expect(403);

    const initial = (await api()
      .get(`/api/v1/driver/trips/${trip.id}`)
      .set('Authorization', driverToken)
      .expect(200)).body;
    const first = initial.stops[0];
    const later = initial.stops[1];
    expect(initial.nextStopId).toBe(first.stopId);
    await api()
      .get(`/api/v1/driver/trips/${trip.id}`)
      .set('Authorization', driverAuth(f.driver.userId))
      .expect(403);
    await api()
      .get(`/api/v1/driver/trips/${trip.id}`)
      .set(
        'Authorization',
        auth({
          tenantId: f.driver.otherTenantId,
          permissions: ['transport:driver:read'],
        }),
      )
      .expect(404);
    await api()
      .post(`/api/v1/driver/trips/${trip.id}/stops/${first.stopId}/action-preview`)
      .set('Authorization', driverToken)
      .send({
        action: 'DELIVER',
        expectedTripVersion: initial.version,
        expectedStopVersion: first.version,
        actingReason: 'Not available to a Driver',
      })
      .expect(403);
    await api()
      .post(`/api/v1/driver/trips/${trip.id}/stops/${later.stopId}/deliver`)
      .set('Authorization', driverToken)
      .send({
        requestId: randomUUID(),
        expectedTripVersion: initial.version,
        expectedStopVersion: later.version,
        confirmed: true,
      })
      .expect(409);

    const requestId = randomUUID();
    const delivery = {
      requestId,
      expectedTripVersion: initial.version,
      expectedStopVersion: first.version,
      confirmed: true,
    };
    const responses = await Promise.all([
      api()
        .post(`/api/v1/driver/trips/${trip.id}/stops/${first.stopId}/deliver`)
        .set('Authorization', driverToken)
        .send(delivery),
      api()
        .post(`/api/v1/driver/trips/${trip.id}/stops/${first.stopId}/deliver`)
        .set('Authorization', driverToken)
        .send(delivery),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(responses[0]!.body).toEqual(responses[1]!.body);
    expect(
      await f.driver.transport.deliveryAttempt.count({
        where: { tenantId: f.driver.tenantId, requestId },
      }),
    ).toBe(1);

    const current = (await api()
      .get(`/api/v1/driver/trips/${trip.id}`)
      .set('Authorization', driverToken)
      .expect(200)).body;
    const finalStop = current.stops[1];
    const adminId = randomUUID();
    const adminToken = auth({
      sub: adminId,
      email: 'qa.superadmin@example.test',
      tenantId: f.driver.tenantId,
      permissions: [],
      isSuperAdmin: true,
    });
    const preview = await api()
      .post(`/api/v1/driver/trips/${trip.id}/stops/${finalStop.stopId}/action-preview`)
      .set('Authorization', adminToken)
      .send({
        action: 'FAIL',
        expectedTripVersion: current.version,
        expectedStopVersion: finalStop.version,
        actingReason: 'Covering the assigned driver',
        reason: 'Recipient unavailable',
      })
      .expect(200);
    const adminRequestId = randomUUID();
    const adminCommand = {
      requestId: adminRequestId,
      expectedTripVersion: current.version,
      expectedStopVersion: finalStop.version,
      confirmed: true,
      previewToken: preview.body.previewToken,
      actingReason: 'Covering the assigned driver',
      reason: 'Recipient unavailable',
    };
    const result = await api()
      .post(`/api/v1/driver/trips/${trip.id}/stops/${finalStop.stopId}/fail`)
      .set('Authorization', adminToken)
      .send(adminCommand)
      .expect(200);
    expect(result.body).toMatchObject({
      actorUserId: adminId,
      actorMode: 'SUPER_ADMIN',
      driverId,
      assigneeUserId: driverUserId,
      status: 'FAILED',
      reason: 'Recipient unavailable',
      actingReason: 'Covering the assigned driver',
    });
    const future = Date.now() + 301_000;
    vi.spyOn(Date, 'now').mockReturnValue(future);
    const recoveredAdminReceipt = await api()
      .post(`/api/v1/driver/trips/${trip.id}/stops/${finalStop.stopId}/fail`)
      .set('Authorization', adminToken)
      .send(adminCommand)
      .expect(200);
    expect(recoveredAdminReceipt.body).toEqual(result.body);
    vi.restoreAllMocks();
    const recoveredDriverReceipt = await api()
      .post(`/api/v1/driver/trips/${trip.id}/stops/${first.stopId}/deliver`)
      .set('Authorization', driverToken)
      .send(delivery)
      .expect(200);
    expect(recoveredDriverReceipt.body).toEqual(responses[0]!.body);
    expect(
      await f.driver.transport.deliveryTrip.findUniqueOrThrow({
        where: { id: trip.id },
      }),
    ).toMatchObject({ status: 'COMPLETED' });
    expect(
      await f.driver.transport.deliveryAttempt.count({
        where: { tripStopId: { in: initial.stops.map((stop: { stopId: string }) => stop.stopId) } },
      }),
    ).toBe(2);
    const adminAttempt =
      await f.driver.transport.deliveryAttempt.findFirstOrThrow({
        where: { tenantId: f.driver.tenantId, requestId: adminRequestId },
      });
    expect(adminAttempt).toMatchObject({
      actorUserId: adminId,
      assigneeUserId: driverUserId,
      actorMode: 'SUPER_ADMIN',
      actorDriverId: driverId,
      actingReason: 'Covering the assigned driver',
    });
    const storedAttempt = await f.driver.transport.deliveryAttempt.findFirstOrThrow({
      where: { tenantId: f.driver.tenantId, requestId },
    });
    await expect(
      f.driver.transport.deliveryAttempt.update({
        where: { id: storedAttempt.id },
        data: { reason: 'Attempt to rewrite immutable receipt' },
      }),
    ).rejects.toThrow();
    await expect(
      f.driver.transport.deliveryAttempt.create({
        data: {
          tenantId: f.driver.tenantId,
          tripStopId: first.stopId,
          shipmentId: first.shipmentId,
          attemptNumber: 2,
          status: 'DELIVERED',
          actorDriverId: driverId,
          occurredAt: new Date(),
          correlationId: randomUUID(),
        },
      }),
    ).rejects.toThrow();

    await f.relay().flush();
    await eventually(async () => {
      expect(observed.some((event) => event.eventType === 'DeliveryCompleted' && event.aggregateId === trip.id)).toBe(true);
      expect(observed.some((event) => event.eventType === 'DeliveryFailed' && event.aggregateId === trip.id)).toBe(true);
    });
    const deliveryEvents = observed.filter(
      (event) =>
        (event.eventType === 'DeliveryCompleted' ||
          event.eventType === 'DeliveryFailed') &&
        event.aggregateId === trip.id,
    );
    expect(deliveryEvents).toHaveLength(2);
    for (const event of deliveryEvents) {
      deliveryResultEventSchema.parse(event);
      expect(event.payload).not.toHaveProperty('actorId');
    }

    const nextDraft = (await api()
      .post('/api/v1/trips')
      .set('Authorization', auth())
      .send({
        requestId: randomUUID(),
        warehouseId: f.warehouse.id,
        plannedStartAt: '2027-01-03T08:00:00.000Z',
        vehicleId,
        driverId,
      })
      .expect(201)).body;
    const shipment = await f.seed();
    await api()
      .post(`/api/v1/trips/${nextDraft.id}/shipments`)
      .set('Authorization', auth())
      .send({
        requestId: randomUUID(),
        expectedTripVersion: nextDraft.version,
        shipments: [{ shipmentId: shipment.id, expectedShipmentVersion: Number(shipment.version) }],
      })
      .expect(200);
    const next = await detail(nextDraft.id);
    const plan = (await api()
      .post(`/api/v1/trips/${next.id}/route-plans/manual`)
      .set('Authorization', auth())
      .send({
        requestId: randomUUID(),
        expectedTripVersion: next.version,
        orderedStopIds: next.stops.map((stop) => stop.id),
      })
      .expect(201)).body as { id: string; planVersion: number; inputHash: string };
    const selection = {
      expectedVersion: next.version,
      planId: plan.id,
      planVersion: plan.planVersion,
      inputHash: plan.inputHash,
    };
    const approvalPreview = (await api()
      .post(`/api/v1/trips/${next.id}/route-approval-preview`)
      .set('Authorization', auth())
      .send(selection)
      .expect(200)).body as { previewToken: string };
    await api()
      .post(`/api/v1/trips/${next.id}/approve-route`)
      .set('Authorization', auth())
      .send({
        ...selection,
        requestId: randomUUID(),
        confirmed: true,
        previewToken: approvalPreview.previewToken,
      })
      .expect(200);
    expect(
      (await f.driver.transport.deliveryTrip.findUniqueOrThrow({
        where: { id: next.id },
      })).status,
    ).toBe('APPROVED');
    const approvedAgain = await f.driver.transport.deliveryTrip.findUniqueOrThrow({
      where: { id: next.id },
    });
    await api()
      .post(`/api/v1/trips/${next.id}/reopen`)
      .set('Authorization', auth())
      .send({
        requestId: randomUUID(),
        expectedVersion: Number(approvedAgain.version),
        reason: 'Owned Driver test teardown',
      })
      .expect(200);
  });

  it('commits complete multi-order receipts and exactly one ISSUE per Shipment; never from TripDispatched', async () => {
    const { trip, shipments } = await approved();
    const body = await command(trip);
    const result = tripDispatchOperationSchema.parse((await dispatch(trip, body).expect(200)).body);
    expect(result.status).toBe('COMPLETED');
    expect(result.result?.status).toBe('IN_PROGRESS');
    const row = await f.driver.transport.tripDispatch.findFirstOrThrow({ where: { idempotencyKey: body.requestId } });
    const payload = batchDispatchGrantRequestSchema.parse(row.payload);
    const header = await f.fulfillment.shipmentDispatchBatch.findUniqueOrThrow({ where: { id: body.requestId } });
    expect(header.status).toBe('COMPLETED');
    for (const item of payload.shipments) {
      expect((await f.orders.salesOrder.findUniqueOrThrow({ where: { id: item.orderId } })).dispatchRequestId).toBe(item.dispatchRequestId);
      expect(await f.fulfillment.shipmentStatusHistory.count({ where: { shipmentId: item.shipmentId, toStatus: 'DISPATCHED' } })).toBe(1);
      expect(await f.fulfillment.outboxEvent.count({ where: { aggregateId: item.shipmentId, eventType: 'ShipmentDispatched' } })).toBe(1);
    }
    expect(await f.driver.transport.outboxEvent.count({ where: { aggregateId: trip.id, eventType: 'TripDispatched' } })).toBe(1);
    await fulfillmentRelay.flush();
    await eventually(async () => {
      expect(await f.inventory!.reservationGroup.count({
        where: { id: { in: shipments.map((item) => item.reservationGroupId) }, status: 'ISSUED' },
      })).toBe(shipments.length);
    });
    expect(await f.inventory!.stockMovement.count({ where: { referenceId: { in: shipments.map((item) => item.id) }, movementType: 'ISSUE' } })).toBe(2);
    const shipmentEvents = observed.filter((event) => event.eventType === 'ShipmentDispatched' &&
      shipments.some((item) => item.id === event.aggregateId));
    const rawProducer = f.broker.kafka.producer();
    await rawProducer.connect();
    try {
      for (const event of shipmentEvents) await rawProducer.send({
        topic: f.broker.topic, messages: [event, { ...event, eventId: randomUUID() }]
          .map((copy) => ({ key: copy.aggregateId, value: JSON.stringify(copy) })),
      });
    } finally { await rawProducer.disconnect(); }
    await eventually(async () => expect(await f.inventory!.inboxEvent.count({
      where: { aggregateId: { in: shipments.map((item) => item.id) } },
    })).toBeGreaterThanOrEqual(4));
    expect(await f.inventory!.stockMovement.count({ where: { referenceId: { in: shipments.map((item) => item.id) } } })).toBe(2);
    const tripEvent = observed.find((event) => event.eventType === 'TripDispatched' && event.aggregateId === trip.id);
    expect(tripEvent).toBeDefined();
    tripDispatchedEventV2Schema.parse(tripEvent);
    await issue.handle(tripEvent!);
    expect(await f.inventory!.stockMovement.count({ where: { referenceId: trip.id } })).toBe(0);
    const originalEvent = shipmentEvents[0]!;
    const mismatchEvent = { ...originalEvent, eventId: randomUUID(),
      payload: { ...originalEvent.payload as Record<string, unknown>, dispatchRequestId: randomUUID() } };
    await expect(issue.handle(mismatchEvent)).rejects.toThrow('another dispatch');
    expect(await f.inventory!.inboxEvent.count({ where: { eventId: mismatchEvent.eventId } })).toBe(0);
    expect((await operation(trip, body.requestId)).status).toBe('COMPLETED');
  });

  it('retains Shipment ISSUE outbox on producer failure and replays the same event after broker ACK / database rollback', async () => {
    const { trip, shipments } = await approved();
    await dispatch(trip, await command(trip)).expect(200);
    const event = await f.fulfillment.outboxEvent.findFirstOrThrow({ where: { aggregateId: shipments[0]!.id, eventType: 'ShipmentDispatched' } });
    await producer.onModuleDestroy();
    await fulfillmentRelay.flush();
    expect((await f.fulfillment.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).publishedAt).toBeNull();
    expect((await f.fulfillment.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).attemptCount).toBe(1);
    await producer.onModuleInit();
    await new Promise((resolve) => setTimeout(resolve, 150));
    const store = new PrismaOutboxStore(f.fulfillment, 'fulfillment', ServiceId.FULFILLMENT_SERVICE, 30000);
    const faulty = new OutboxRelay({
      withLockedBatch: (size, callback) => store.withLockedBatch(size, (records, tx) => callback(records, {
        ...tx, markPublished: async (id, timestamp) => {
          await tx.markPublished(id, timestamp);
          if (id === event.id) throw new Error('fault after Shipment broker ACK before database mark commit');
        },
      })),
    }, producer, { topic: f.broker.topic, intervalMs: 100, batchSize: 100, retryBaseMs: 100, retryMaxMs: 1000 });
    await expect(faulty.flush()).rejects.toThrow('fault after Shipment broker ACK');
    expect((await f.fulfillment.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).publishedAt).toBeNull();
    await fulfillmentRelay.flush();
    await eventually(async () => {
      expect(observed.filter((row) => row.eventId === event.id).length).toBeGreaterThanOrEqual(2);
      expect(await f.inventory!.stockMovement.count({ where: { referenceId: event.aggregateId, movementType: 'ISSUE' } })).toBe(1);
    });
  });

  it('replays exact payload before expired preview, binds actor and rejects payload changes and concurrent duplicate effects', async () => {
    const { trip } = await approved();
    const body = await command(trip);
    const responses = await Promise.all([dispatch(trip, body), dispatch(trip, body)]);
    expect(
      responses.every((response) => [200, 202].includes(response.status)),
      JSON.stringify(responses.map((response) => ({
        status: response.status,
        error: response.body?.error,
        code: response.body?.code,
      }))),
    ).toBe(true);
    const committed = await operation(trip, body.requestId);
    expect(committed.status).toBe('COMPLETED');
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 301000);
    expect(tripDispatchOperationSchema.parse((await dispatch(trip, body).expect(200)).body).status).toBe('COMPLETED');
    vi.restoreAllMocks();
    await dispatch(trip, { ...body, version: body.version + 1 }).expect(409);
    await api().post(`/api/v1/trips/${trip.id}/dispatch`).set('Authorization', auth({ sub: randomUUID() })).send(body).expect(409);
    expect(await f.driver.transport.tripDispatch.count({ where: { tripId: trip.id } })).toBe(1);
    expect(await f.driver.transport.outboxEvent.count({ where: { aggregateId: trip.id, eventType: 'TripDispatched' } })).toBe(1);
  });

  it('enforces unauthenticated, permission, tenant and confirmation failures before intent', async () => {
    const { trip } = await approved();
    const body = await command(trip);
    await api().post(`/api/v1/trips/${trip.id}/dispatch`).send(body).expect(401);
    await api().post(`/api/v1/trips/${trip.id}/dispatch`).set('Authorization', auth({ permissions: [] })).send(body).expect(403);
    await api().post(`/api/v1/trips/${trip.id}/dispatch`).set('Authorization', auth({ tenantId: f.driver.otherTenantId })).send(body).expect(404);
    await api().post(`/api/v1/trips/${trip.id}/dispatch`).set('Authorization', auth()).send({ ...body, confirmed: false }).expect(400);
    await dispatch(trip, { ...body, previewToken: `${body.previewToken}x` }).expect(422);
    expect(await f.driver.transport.tripDispatch.count({ where: { tripId: trip.id } })).toBe(0);
  });

  it('rejects assigned direct dispatch while preserving unassigned single-grant dispatch', async () => {
    const { trip, shipments } = await approved();
    const current = await f.fulfillment.shipment.findUniqueOrThrow({ where: { id: shipments[0]!.id } });
    await expect(f.directDispatch.dispatch(current.id, {
      requestId: randomUUID(), version: Number(current.version), orderVersion: 2, confirmed: true,
    }, { tenantId: f.driver.tenantId, actorId: f.driver.userId, correlationId: randomUUID() })).rejects.toThrow();
    const single = await f.seed();
    await f.orders.salesOrder.update({ where: { id: single.orderId }, data: { status: 'READY_TO_SHIP' } });
    await f.directDispatch.dispatch(single.id, {
      requestId: randomUUID(), version: Number(single.version), orderVersion: 2, confirmed: true,
    }, { tenantId: f.driver.tenantId, actorId: f.driver.userId, correlationId: randomUUID() });
    expect((await f.fulfillment.shipment.findUniqueOrThrow({ where: { id: single.id } })).status).toBe('DISPATCHED');
    expect((await detail(trip.id)).status).toBe('APPROVED');
  });

  it('durably rejects the full set when a Shipment changes before Fulfillment preparation', async () => {
    const { trip, shipments } = await approved();
    const body = await command(trip);
    const original = f.batchDispatch.dispatch.bind(f.batchDispatch);
    vi.spyOn(f.batchDispatch, 'dispatch').mockImplementationOnce(async (payload) => {
      await f.fulfillment.shipment.update({
        where: { id: shipments[1]!.id }, data: { status: 'CANCELED', version: { increment: 1 } },
      });
      return original(payload);
    });
    const result = tripDispatchOperationSchema.parse((await dispatch(trip, body).expect(200)).body);
    expect(result.status).toBe('REJECTED');
    const batch = await f.fulfillment.shipmentDispatchBatch.findUniqueOrThrow({ where: { id: body.requestId } });
    expect(batch).toMatchObject({ status: 'REJECTED', lastError: 'SHIPMENT_NOT_DISPATCHABLE' });
    expect(await f.fulfillment.shipmentDispatchIntent.count({ where: { batchId: body.requestId } })).toBe(0);
    expect(await f.orders.orderDispatchBatch.count({ where: { id: body.requestId } })).toBe(0);
    expect(await f.orders.salesOrder.count({
      where: { id: { in: shipments.map((item) => item.orderId) }, dispatchGrantedAt: { not: null } },
    })).toBe(0);
    expect(tripDispatchOperationSchema.parse((await dispatch(trip, body).expect(200)).body)).toEqual(result);
  });

  it('recovers lost response after irrevocable whole-set Order grant, fail-closing cancellation and restart', async () => {
    const { trip, shipments } = await approved();
    const body = await command(trip);
    f.fault.dropOrderBatchResponse = true;
    const response = await dispatch(trip, body).expect(202);
    expect(tripDispatchOperationSchema.parse(response.body).stage).toBe('SUBMITTED');
    expect(await f.orders.salesOrder.count({ where: { id: { in: shipments.map((item) => item.orderId) }, dispatchGrantedAt: { not: null } } })).toBe(2);
    expect(await f.fulfillment.shipment.count({ where: { id: { in: shipments.map((item) => item.id) }, status: 'DISPATCHED' } })).toBe(0);
    await api().post(`/api/v1/trips/${trip.id}/reopen`).set('Authorization', auth()).send({
      requestId: randomUUID(), expectedVersion: trip.version, reason: 'must not undo unknown grant',
    }).expect(409);
    const cancel = (await api().post(`/api/v1/trips/${trip.id}/cancel-preview`).set('Authorization', auth())
      .send({ expectedVersion: trip.version }).expect(200)).body as { previewToken: string; blockers: string[] };
    expect(cancel.blockers).toContain('TRIP_OPERATION_PENDING');
    await api().post(`/api/v1/trips/${trip.id}/cancel`).set('Authorization', auth()).send({
      requestId: randomUUID(), expectedVersion: trip.version, reason: 'must fail closed',
      previewToken: cancel.previewToken, confirmed: true,
    }).expect(409);
    await f.restartOrders();
    await f.restartFulfillment();
    await f.restartTransport();
    await eventually(async () => expect((await operation(trip, body.requestId)).status).toBe('COMPLETED'));
    expect(await f.orders.orderDispatchBatch.count({ where: { id: body.requestId } })).toBe(1);
  });

  it('recovers Shipment commit before Trip commit without revalidation or duplicate lifecycle effects', async () => {
    const { trip, shipments } = await approved();
    const body = await command(trip);
    f.fault.dropBatchResponse = true;
    await dispatch(trip, body).expect(202);
    expect(await f.fulfillment.shipment.count({ where: { id: { in: shipments.map((item) => item.id) }, status: 'DISPATCHED' } })).toBe(2);
    expect((await detail(trip.id)).status).toBe('APPROVED');
    await f.restartTransport();
    await eventually(async () => expect((await operation(trip, body.requestId)).status).toBe('COMPLETED'));
    expect(await f.fulfillment.shipmentStatusHistory.count({ where: { shipmentId: { in: shipments.map((item) => item.id) }, toStatus: 'DISPATCHED' } })).toBe(2);
  });

  it('recovers after Transport intent and after Fulfillment intent using persisted exact children', async () => {
    const first = await approved();
    const firstBody = await command(first.trip);
    vi.spyOn(f.transportService(TripDispatchService), 'resume').mockRejectedValueOnce(new Error('fault after Transport intent'));
    await dispatch(first.trip, firstBody).expect(500);
    expect(await f.driver.transport.tripDispatch.count({ where: { tripId: first.trip.id, stage: 'ACCEPTED' } })).toBe(1);
    vi.restoreAllMocks();
    await f.restartTransport();
    expect((await operation(first.trip, firstBody.requestId)).status).toBe('COMPLETED');
    const second = await approved();
    const secondBody = await command(second.trip);
    vi.spyOn(f.batchDispatch, 'complete').mockRejectedValueOnce(new Error('fault after Fulfillment intent'));
    await dispatch(second.trip, secondBody).expect(202);
    const stored = await f.fulfillment.shipmentDispatchBatch.findUniqueOrThrow({ where: { id: secondBody.requestId } });
    expect(stored.stage).toBe('PREPARED');
    const payload = batchDispatchGrantRequestSchema.parse(stored.payload);
    vi.restoreAllMocks();
    await f.restartTransport();
    expect((await operation(second.trip, secondBody.requestId)).status).toBe('COMPLETED');
    for (const item of payload.shipments) {
      expect((await f.fulfillment.shipmentDispatchIntent.findUniqueOrThrow({ where: { shipmentId: item.shipmentId } })).id).toBe(item.dispatchRequestId);
    }
  });

  it('persists Order receipt before Shipment transition and resumes forward from that boundary', async () => {
    const { trip, shipments } = await approved();
    const body = await command(trip);
    vi.spyOn(f.batchDispatch, 'commit').mockRejectedValueOnce(new Error('fault after durable Order receipt'));
    await dispatch(trip, body).expect(202);
    const batch = await f.fulfillment.shipmentDispatchBatch.findUniqueOrThrow({ where: { id: body.requestId } });
    expect(batch.stage).toBe('GRANTED');
    expect(batch.decision).toMatchObject({ decision: 'GRANTED' });
    const children = await f.fulfillment.shipmentDispatchIntent.findMany({ where: { batchId: body.requestId } });
    expect(children).toHaveLength(2);
    expect(children.every((child) => child.grantReceipt !== null)).toBe(true);
    expect(await f.fulfillment.shipment.count({ where: { id: { in: shipments.map((item) => item.id) }, status: 'DISPATCHED' } })).toBe(0);
    vi.restoreAllMocks();
    await f.restartFulfillment();
    await f.recoverFulfillment();
    expect((await f.fulfillment.shipmentDispatchBatch.findUniqueOrThrow({ where: { id: body.requestId } })).status).toBe('COMPLETED');
    await f.restartTransport();
    expect((await operation(trip, body.requestId)).status).toBe('COMPLETED');
  });

  it('recovers after the Transport durable receipt but before local Trip/outbox commit', async () => {
    const { trip, vehicleId } = await approved();
    const body = await command(trip);
    vi.spyOn(f.transportService(TripDispatchService), 'commit').mockRejectedValueOnce(new Error('fault before Trip commit'));
    await dispatch(trip, body).expect(202);
    const stored = await f.driver.transport.tripDispatch.findFirstOrThrow({ where: { idempotencyKey: body.requestId } });
    expect(stored.stage).toBe('RECEIPTED');
    expect(stored.receipt).toMatchObject({ status: 'COMPLETED' });
    expect(await f.driver.transport.outboxEvent.count({ where: { aggregateId: trip.id, eventType: 'TripDispatched' } })).toBe(0);
    await f.driver.master.vehicle.update({ where: { id: vehicleId }, data: { status: 'INACTIVE', version: { increment: 1 } } });
    vi.restoreAllMocks();
    await f.restartTransport();
    expect((await operation(trip, body.requestId)).status).toBe('COMPLETED');
    expect(await f.driver.transport.outboxEvent.count({ where: { aggregateId: trip.id, eventType: 'TripDispatched' } })).toBe(1);
  });

  it.each(['CANCEL_FIRST', 'RACE'] as const)('whole-set grant versus actual owning cancellation: %s', async (mode) => {
    const { trip, shipments } = await approved();
    const body = await command(trip);
    const original = f.orderClient.authorizeBatch.bind(f.orderClient);
    let canceled: PromiseSettledResult<unknown> | undefined;
    vi.spyOn(f.orderClient, 'authorizeBatch').mockImplementationOnce(async (payload) => {
      const cancel = () => f.orderCommands!.cancel(shipments[1]!.orderId, { version: 2, reason: 'Whole-set arbitration proof' }, {
        tenantId: f.driver.tenantId, actorId: f.driver.userId, correlationId: randomUUID(), authorization: auth(),
      });
      if (mode === 'CANCEL_FIRST') {
        await cancel();
        return original(payload);
      }
      const results = await Promise.allSettled([original(payload), cancel()]);
      canceled = results[1];
      if (results[0].status === 'rejected') throw results[0].reason;
      return results[0].value;
    });
    const result = tripDispatchOperationSchema.parse((await dispatch(trip, body).expect(200)).body);
    const grants = await f.orders.salesOrder.count({
      where: { id: { in: shipments.map((item) => item.orderId) }, dispatchGrantedAt: { not: null } },
    });
    expect([0, 2]).toContain(grants);
    expect(result.status).toBe(grants === 2 ? 'COMPLETED' : 'REJECTED');
    if (mode === 'CANCEL_FIRST') expect(grants).toBe(0);
    if (mode === 'RACE') expect(canceled?.status).toBe(grants === 2 ? 'rejected' : 'fulfilled');
    const stored = await f.driver.transport.tripDispatch.findFirstOrThrow({ where: { idempotencyKey: body.requestId } });
    const payload = batchDispatchGrantRequestSchema.parse(stored.payload);
    const replay = await original(payload);
    expect(replay.decision).toBe(grants === 2 ? 'GRANTED' : 'REJECTED');
    await expect(original({ ...payload, actorId: randomUUID() })).rejects.toThrow();
    expect(await f.fulfillment.shipment.count({
      where: { id: { in: shipments.map((item) => item.id) }, status: 'DISPATCHED' },
    })).toBe(grants);
  });

  it('revalidates changed authoritative capacity, readiness, preview actor, expiry and confirmation before grant', async () => {
    const { trip, vehicleId, shipments } = await approved();
    const body = await command(trip);
    await api().post(`/api/v1/trips/${trip.id}/dispatch`).set('Authorization', auth({ sub: randomUUID() })).send(body).expect(422);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 301000);
    await dispatch(trip, body).expect(422);
    vi.restoreAllMocks();
    await f.driver.master.vehicle.update({ where: { id: vehicleId }, data: { capacityWeight: '0.001', version: { increment: 1 } } });
    await dispatch(trip, body).expect(422);
    await f.driver.master.vehicle.update({ where: { id: vehicleId }, data: { capacityWeight: '100.000', version: { increment: 1 } } });
    await f.fulfillment.shipment.update({ where: { id: shipments[0]!.id }, data: { status: 'CANCELED', version: { increment: 1 } } });
    await dispatch(trip, body).expect(409);
    expect(await f.orders.salesOrder.count({
      where: { id: { in: shipments.map((item) => item.orderId) }, dispatchGrantedAt: { not: null } },
    })).toBe(0);
    expect(await f.driver.transport.tripDispatch.count({ where: { tripId: trip.id } })).toBe(0);
  });

  it('cancellation before release does not release reservations; post-grant Order cancel is rejected', async () => {
    const { trip, shipments } = await approved();
    const preview = (await api().post(`/api/v1/trips/${trip.id}/cancel-preview`).set('Authorization', auth())
      .send({ expectedVersion: trip.version }).expect(200)).body as { previewToken: string };
    await api().post(`/api/v1/trips/${trip.id}/cancel`).set('Authorization', auth()).send({
      requestId: randomUUID(), expectedVersion: trip.version, reason: 'Owned trip canceled, Orders retained',
      previewToken: preview.previewToken, confirmed: true,
    }).expect(200);
    expect(await f.inventory!.reservationGroup.count({
      where: { id: { in: shipments.map((item) => item.reservationGroupId) }, status: 'ACTIVE' },
    })).toBe(2);
    expect(await f.fulfillment.shipment.count({ where: { id: { in: shipments.map((item) => item.id) }, assignedTripId: null } })).toBe(2);
    const next = await approved();
    const body = await command(next.trip);
    await dispatch(next.trip, body).expect(200);
    const order = await f.orders.salesOrder.findUniqueOrThrow({ where: { id: next.shipments[0]!.orderId } });
    await expect(f.orderCommands!.cancel(order.id, { version: Number(order.version), reason: 'Cannot undo grant' }, {
      tenantId: f.driver.tenantId, actorId: f.driver.userId, correlationId: randomUUID(), authorization: auth(),
    })).rejects.toThrow();
  });
});
