import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { z } from 'zod';
import {
  KafkaProducerService, OutboxRelay, PrismaOutboxStore,
  tripRoutePlanViewSchema, tripRoutePreviewViewSchema,
  routeApprovedPayloadV2Schema,
} from '@logix/messaging';
import { ServiceId } from '@logix/common';
import { signInternalServiceToken } from '@logix/auth';
import { routeHash } from '../src/routes/route-domain.js';
import { tripFixture } from './support/trip-fixture.js';

const tripSchema = z.object({
  id: z.string().uuid(), version: z.number().int(), status: z.string(),
  approvedRoutePlanId: z.string().uuid().nullable(),
  vehicleSnapshot: z.unknown(), driverSnapshot: z.unknown(),
  stops: z.array(z.object({ id: z.string().uuid(), approvedSequence: z.number().nullable(), deletedAt: z.string().nullable() }).passthrough()),
}).passthrough();
type Trip = z.infer<typeof tripSchema>;

describe('Phase 3 Gateway / real owning APIs / PostgreSQL / optimizer / Kafka', () => {
  let f: Awaited<ReturnType<typeof tripFixture>>;
  let driverId: string, secondDriverId: string;
  const permissions = [
    'transport:trip:read', 'transport:trip:create', 'transport:trip:update',
    'transport:route:read', 'transport:route:optimize', 'transport:route:approve',
    'master-data:warehouse:read', 'master-data:vehicle:read', 'master-data:vehicle:manage',
    'master-data:driver:read', 'master-data:driver:manage',
  ];
  const auth = () => `Bearer ${f.driver.token(permissions)}`;
  const api = () => request(f.url);
  const events: Array<Record<string, unknown>> = [];
  let disconnectObserver: (() => Promise<void>) | undefined;
  const waitFor = async (predicate: () => Promise<boolean>, message: string) => {
    for (let index = 0; index < 100; index++) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(message);
  };
  beforeAll(async () => {
    f = await tripFixture({ optimizer: true });
    const createDriver = async (userId: string) => {
      const result = await api().post('/api/v1/drivers').set('Authorization', auth()).send({
        code: `D-${randomUUID()}`, userId, licenseNumber: `L-${randomUUID()}`, licenseExpiry: '2030-12-31',
      }).expect(201);
      return z.object({ id: z.string().uuid() }).parse(result.body).id;
    };
    driverId = await createDriver(f.driver.userId);
    secondDriverId = await createDriver(await f.driver.addEligibleUser());
    const observer = f.broker.kafka.consumer({ groupId: `phase3-observer-${randomUUID()}` });
    await observer.connect();
    await observer.subscribe({ topic: f.broker.topic, fromBeginning: true });
    await observer.run({
      eachMessage: async ({ message }) => {
        if (message.value) events.push(z.record(z.string(), z.unknown()).parse(JSON.parse(message.value.toString())));
      },
    });
    disconnectObserver = () => observer.disconnect();
  }, 120000);
  afterEach(async () => {
    vi.restoreAllMocks();
    f.optimizerFault.corruptHash = false;
    f.optimizerFault.dropResponse = false;
    f.optimizerFault.delayResponseMs = 0;
    const approved = await f.driver.transport.deliveryTrip.findMany({ where: { tenantId: f.driver.tenantId, status: 'APPROVED' } });
    for (const trip of approved)
      await api().post(`/api/v1/trips/${trip.id}/reopen`).set('Authorization', auth())
        .send({ requestId: randomUUID(), expectedVersion: Number(trip.version), reason: 'Owned test teardown' }).expect(200);
  });
  afterAll(async () => {
    if (disconnectObserver) await disconnectObserver();
    if (f) await f.close();
  }, 60000);

  const detail = async (id: string) => tripSchema.parse((await api().get(`/api/v1/trips/${id}`).set('Authorization', auth()).expect(200)).body);
  const vehicle = async (weight = '100.000', volume = '10.000000') => {
    const result = await api().post('/api/v1/vehicles').set('Authorization', auth()).send({
      code: `V-${randomUUID()}`, licensePlate: `QA-${randomUUID().slice(0, 12)}`, capacityWeight: weight, capacityVolume: volume,
    }).expect(201);
    return z.object({ id: z.string().uuid() }).parse(result.body).id;
  };
  const draft = async (options: { vehicleId?: string; driver?: string; weight?: string; volume?: string; count?: number; start?: string } = {}) => {
    const created = await api().post('/api/v1/trips').set('Authorization', auth()).send({
      requestId: randomUUID(), warehouseId: f.warehouse.id,
      plannedStartAt: options.start ?? '2027-01-02T08:00:00.000Z',
      vehicleId: options.vehicleId ?? await vehicle(), driverId: options.driver ?? driverId,
    }).expect(201);
    const trip = tripSchema.parse(created.body);
    const shipments = [];
    for (let index = 0; index < (options.count ?? 2); index++)
      shipments.push(await f.seed({ weight: options.weight ?? '1.125', volume: options.volume ?? '0.011250' }));
    await api().post(`/api/v1/trips/${trip.id}/shipments`).set('Authorization', auth()).send({
      requestId: randomUUID(), expectedTripVersion: trip.version,
      shipments: shipments.map((shipment) => ({ shipmentId: shipment.id, expectedShipmentVersion: Number(shipment.version) })),
    }).expect(200);
    return detail(trip.id);
  };
  const manual = async (trip: Trip, ids = trip.stops.map((stop) => stop.id)) => {
    const response = await api().post(`/api/v1/trips/${trip.id}/route-plans/manual`).set('Authorization', auth())
      .send({ requestId: randomUUID(), expectedTripVersion: trip.version, orderedStopIds: ids }).expect(201);
    return tripRoutePlanViewSchema.parse(response.body);
  };
  const selection = (trip: Trip, plan: z.infer<typeof tripRoutePlanViewSchema>) => ({
    expectedVersion: trip.version, planId: plan.id, planVersion: plan.planVersion, inputHash: plan.inputHash,
  });
  const preview = async (trip: Trip, plan: z.infer<typeof tripRoutePlanViewSchema>, extra: Record<string, unknown> = {}) =>
    tripRoutePreviewViewSchema.parse((await api().post(`/api/v1/trips/${trip.id}/route-approval-preview`)
      .set('Authorization', auth()).send({ ...selection(trip, plan), ...extra }).expect(200)).body);
  const approve = (trip: Trip, plan: z.infer<typeof tripRoutePlanViewSchema>, token: string, requestId = randomUUID()) =>
    api().post(`/api/v1/trips/${trip.id}/approve-route`).set('Authorization', auth())
      .send({ ...selection(trip, plan), requestId, confirmed: true, previewToken: token });
  const canceledShipment = async (trip: Trip) => {
    const member = await f.driver.transport.tripShipment.findFirstOrThrow({ where: { tripId: trip.id, state: 'ACTIVE' } });
    const shipment = await f.fulfillment.shipment.update({ where: { id: member.shipmentId }, data: { status: 'CANCELED', version: { increment: 1 } } });
    return {
      eventId: randomUUID(), eventType: 'ShipmentCanceled', eventVersion: 1, occurredAt: new Date().toISOString(),
      producer: ServiceId.FULFILLMENT_SERVICE, tenantId: f.driver.tenantId, actorId: null,
      correlationId: randomUUID(), causationId: randomUUID(), aggregateType: 'Shipment',
      aggregateId: shipment.id, aggregateVersion: Number(shipment.version),
      payload: { shipmentId: shipment.id, orderId: shipment.orderId, reservationGroupId: shipment.reservationGroupId,
        warehouseId: shipment.warehouseId, dispatchRequestId: null, reason: 'ORDER_CANCELED', actorId: null },
    };
  };
  const publishCanceled = async (event: Awaited<ReturnType<typeof canceledShipment>>) => {
    const producer = f.broker.kafka.producer();
    await producer.connect();
    try {
      await producer.send({ topic: f.broker.topic, messages: [1, 2].map(() => ({ key: event.aggregateId, value: JSON.stringify(event) })) });
    } finally { await producer.disconnect(); }
  };

  it('runs manual → signed approval → reopen → persisted optimizer → approval, freezing history and actual wire fixtures', async () => {
    const trip = await draft();
    const plan = await manual(trip, trip.stops.map((stop) => stop.id).reverse());
    expect(plan).toMatchObject({ source: 'MANUAL', totalDistance: null, estimatedCost: null, metrics: null, solverName: null, approvedAt: null });
    expect(plan.stops.every((stop) => stop.eta === null && stop.legDistance === null && stop.legDurationSeconds === null)).toBe(true);
    const p = await preview(trip, plan);
    const commandId = randomUUID();
    const approved = tripSchema.parse((await approve(trip, plan, p.previewToken, commandId).expect(200)).body);
    expect(approved.status).toBe('APPROVED');
    expect(approved.approvedRoutePlanId).not.toBe(plan.id);
    expect(approved.stops.map((stop) => stop.approvedSequence)).toEqual([2, 1]);
    const approvalPlan = await f.driver.transport.routePlan.findUniqueOrThrow({ where: { id: approved.approvedRoutePlanId! } });
    expect(approvalPlan.approvedBy).toBe(f.driver.userId);
    const reopened = tripSchema.parse((await api().post(`/api/v1/trips/${trip.id}/reopen`).set('Authorization', auth())
      .send({ requestId: randomUUID(), expectedVersion: approved.version, reason: 'Choose real optimizer proposal' }).expect(200)).body);
    expect(reopened.status).toBe('DRAFT');
    expect(reopened.approvedRoutePlanId).toBeNull();
    expect(reopened.stops.every((stop) => stop.approvedSequence === null)).toBe(true);
    const optimizeBody = { requestId: randomUUID(), expectedTripVersion: reopened.version };
    const optimized = tripRoutePlanViewSchema.parse((await api().post(`/api/v1/trips/${trip.id}/route-optimizations`)
      .set('Authorization', auth()).send(optimizeBody).expect(201)).body);
    expect(optimized.source).toBe('OPTIMIZED');
    expect(optimized.optimizationRunId).not.toBe(trip.id);
    expect(optimized.optimizationRunId).not.toBe(optimized.id);
    expect(optimized.totalDistance).not.toBeNull();
    expect(optimized.metrics?.persisted).toBe(true);
    expect(optimized.metrics?.distance_provider).toContain('Haversine');
    expect(optimized.solverVersion).toMatch(/\d/);
    const internalToken = (tenantId: string) => signInternalServiceToken({
      service: ServiceId.TRANSPORT_SERVICE, audience: ServiceId.ROUTE_OPTIMIZER_SERVICE,
      tenantId, secret: f.driver.secret, ttlSeconds: 60,
    });
    const runUrl = new URL(`/api/v1/route-optimizations/${optimized.optimizationRunId}`, f.optimizerUrl);
    const run = await fetch(runUrl, { headers: { 'x-internal-service-token': internalToken(f.driver.tenantId) } });
    expect(run.status).toBe(200);
    expect(await run.json()).toMatchObject({ persisted: true, input_hash: optimized.inputHash, route_request_id: optimizeBody.requestId });
    expect((await fetch(runUrl, { headers: { 'x-internal-service-token': internalToken(f.driver.otherTenantId) } })).status).toBe(404);
    const persistedPlan = await f.driver.transport.routePlan.findUniqueOrThrow({ where: { id: optimized.id } });
    const savedRequest = z.record(z.string(), z.unknown()).parse(persistedPlan.optimizerRequest);
    expect((await fetch(new URL('/api/v1/route-optimizations', f.optimizerUrl), {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-service-token': internalToken(f.driver.otherTenantId) },
      body: JSON.stringify(savedRequest),
    })).status).toBe(403);
    const changedSnapshot = {
      ...z.record(z.string(), z.unknown()).parse(savedRequest.input_snapshot),
      plannedStartAt: '2027-01-03T08:00:00.000Z',
    };
    expect((await fetch(new URL('/api/v1/route-optimizations', f.optimizerUrl), {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-service-token': internalToken(f.driver.tenantId) },
      body: JSON.stringify({ ...savedRequest, input_snapshot: changedSnapshot, input_hash: routeHash(changedSnapshot) }),
    })).status).toBe(409);
    const retry = await api().post(`/api/v1/trips/${trip.id}/route-optimizations`).set('Authorization', auth()).send(optimizeBody).expect(201);
    expect(retry.body).toEqual(optimized);
    const p2 = await preview(reopened, optimized);
    const approvedAgain = tripSchema.parse((await approve(reopened, optimized, p2.previewToken).expect(200)).body);
    expect(approvedAgain.approvedRoutePlanId).not.toBe(approved.approvedRoutePlanId);
    expect(await f.driver.transport.routePlan.findUniqueOrThrow({ where: { id: approvalPlan.id } })).toEqual(approvalPlan);
    await waitFor(async () => events.some((event) => event.eventType === 'RouteApproved' && event.correlationId === commandId), 'RouteApproved was not published to the real Kafka broker');
    const emitted = events.find((event) => event.eventType === 'RouteApproved' && event.correlationId === commandId)!;
    expect(emitted.eventVersion).toBe(2);
    expect(routeApprovedPayloadV2Schema.parse(emitted.payload)).toMatchObject({ actorId: f.driver.userId, tripId: trip.id, routePlanId: approved.approvedRoutePlanId });
    const list = (await api().get(`/api/v1/trips/${trip.id}/route-plans`).set('Authorization', auth()).expect(200)).body;
    expect(z.object({ items: z.array(tripRoutePlanViewSchema) }).parse(list).items).toHaveLength(4);
    if (process.env.PHASE3_RUNTIME_CONTRACT_OUTPUT) {
      const output = process.env.PHASE3_RUNTIME_CONTRACT_OUTPUT;
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, JSON.stringify({
        list, plan: optimized, preview: { ...p2, previewToken: 'owned-test-preview-token-redacted' },
        approved: approvedAgain, reopened,
      }, null, 2));
    }
  });

  it.each(['vehicle', 'driver'] as const)('serializes competing approvals by tenant+%s across different days and releases on reopen', async (resource) => {
    const sharedVehicle = await vehicle();
    const left = await draft({ vehicleId: sharedVehicle });
    const right = await draft({ vehicleId: resource === 'vehicle' ? sharedVehicle : await vehicle(), driver: resource === 'vehicle' ? secondDriverId : driverId, start: '2027-02-02T08:00:00.000Z' });
    const leftPlan = await manual(left), rightPlan = await manual(right);
    const p1 = await preview(left, leftPlan), p2 = await preview(right, rightPlan);
    const results = await Promise.all([approve(left, leftPlan, p1.previewToken), approve(right, rightPlan, p2.previewToken)]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const winner = tripSchema.parse(results.find((result) => result.status === 200)!.body);
    const loser = winner.id === left.id ? right : left;
    expect(await f.driver.transport.routePlan.count({ where: { tripId: loser.id, approvedAt: { not: null } } })).toBe(0);
    expect(await f.driver.transport.outboxEvent.count({ where: { aggregateId: loser.id, eventType: 'RouteApproved' } })).toBe(0);
    await api().post(`/api/v1/trips/${winner.id}/reopen`).set('Authorization', auth())
      .send({ requestId: randomUUID(), expectedVersion: winner.version, reason: 'Release resource explicitly' }).expect(200);
    const loserPlan = winner.id === left.id ? rightPlan : leftPlan;
    const p3 = await preview(loser, loserPlan);
    await approve(loser, loserPlan, p3.previewToken).expect(200);
  });

  it('accepts exact capacity and rejects weight +0.001 and volume +0.000001 without fake capacity fallback', async () => {
    const exact = await draft({ vehicleId: await vehicle('1.000', '1.000000'), weight: '1.000', volume: '1.000000', count: 1 });
    await manual(exact);
    for (const demand of [{ weight: '1.001', volume: '1.000000' }, { weight: '1.000', volume: '1.000001' }]) {
      const trip = await draft({ vehicleId: await vehicle('1.000', '1.000000'), ...demand, count: 1 });
      await api().post(`/api/v1/trips/${trip.id}/route-plans/manual`).set('Authorization', auth())
        .send({ requestId: randomUUID(), expectedTripVersion: trip.version, orderedStopIds: trip.stops.map((stop) => stop.id) }).expect(422);
      expect(await f.driver.transport.routePlan.count({ where: { tripId: trip.id } })).toBe(0);
    }
  });

  it('rejects incomplete/duplicate/foreign permutations and supports manual exact request replay', async () => {
    const trip = await draft();
    for (const ids of [[], [trip.stops[0].id], [trip.stops[0].id, trip.stops[0].id], [trip.stops[0].id, randomUUID()]]) {
      const result = await api().post(`/api/v1/trips/${trip.id}/route-plans/manual`).set('Authorization', auth())
        .send({ requestId: randomUUID(), expectedTripVersion: trip.version, orderedStopIds: ids });
      expect([400, 422]).toContain(result.status);
    }
    const body = { requestId: randomUUID(), expectedTripVersion: trip.version, orderedStopIds: trip.stops.map((stop) => stop.id) };
    const first = await api().post(`/api/v1/trips/${trip.id}/route-plans/manual`).set('Authorization', auth()).send(body).expect(201);
    expect((await api().post(`/api/v1/trips/${trip.id}/route-plans/manual`).set('Authorization', auth()).send(body).expect(201)).body).toEqual(first.body);
    await api().post(`/api/v1/trips/${trip.id}/route-plans/manual`).set('Authorization', auth()).send({ ...body, orderedStopIds: [...body.orderedStopIds].reverse() }).expect(409);
  });

  it('handles the existing 100-stop request boundary using real fractional demand and rejects a 101-entry order', async () => {
    const trip = await draft({ vehicleId: await vehicle('0.100', '0.000100'), weight: '0.001', volume: '0.000001', count: 100 });
    const plan = await manual(trip);
    expect(plan.stops).toHaveLength(100);
    const optimized = tripRoutePlanViewSchema.parse((await api().post(`/api/v1/trips/${trip.id}/route-optimizations`).set('Authorization', auth())
      .send({ requestId: randomUUID(), expectedTripVersion: trip.version }).expect(201)).body);
    expect(optimized.stops).toHaveLength(100);
    expect(optimized.metrics?.total_demand_weight_kg).toBe(0.1);
    expect(optimized.metrics?.total_demand_volume_m3).toBe(0.0001);
    await api().post(`/api/v1/trips/${trip.id}/route-plans/manual`).set('Authorization', auth()).send({
      requestId: randomUUID(), expectedTripVersion: trip.version,
      orderedStopIds: [...trip.stops.map((stop) => stop.id), randomUUID()],
    }).expect(400);
  }, 60000);

  it('fails closed when actual vehicle/warehouse or Identity eligibility becomes inactive', async () => {
    const trip = await draft(), plan = await manual(trip), p = await preview(trip, plan);
    const dbTrip = await f.driver.transport.deliveryTrip.findUniqueOrThrow({ where: { id: trip.id } });
    try {
      await f.driver.master.vehicle.update({ where: { id: dbTrip.vehicleId! }, data: { status: 'INACTIVE' } });
      await approve(trip, plan, p.previewToken).expect(422);
      await f.driver.master.vehicle.update({ where: { id: dbTrip.vehicleId! }, data: { status: 'ACTIVE' } });
      await f.driver.master.warehouse.update({ where: { id: f.warehouse.id }, data: { status: 'INACTIVE' } });
      await approve(trip, plan, p.previewToken).expect(422);
      await f.driver.master.warehouse.update({ where: { id: f.warehouse.id }, data: { status: 'ACTIVE' } });
      await f.driver.identity.userTenant.updateMany({ where: { userId: f.driver.userId, tenantId: f.driver.tenantId }, data: { status: 'INACTIVE' } });
      const rejected = await approve(trip, plan, p.previewToken);
      expect(rejected.status).toBe(404);
      expect((await detail(trip.id)).status).toBe('DRAFT');
      expect(await f.driver.transport.outboxEvent.count({ where: { aggregateId: trip.id, eventType: 'RouteApproved' } })).toBe(0);
    } finally {
      await f.driver.master.vehicle.update({ where: { id: dbTrip.vehicleId! }, data: { status: 'ACTIVE' } });
      await f.driver.master.warehouse.update({ where: { id: f.warehouse.id }, data: { status: 'ACTIVE' } });
      await f.driver.identity.userTenant.updateMany({ where: { userId: f.driver.userId, tenantId: f.driver.tenantId }, data: { status: 'ACTIVE' } });
    }
  });

  it('requires confirmation, actor/tenant/action/token binding and returns committed receipts before expiry/state checks', async () => {
    const trip = await draft(), plan = await manual(trip), p = await preview(trip, plan);
    const body = { ...selection(trip, plan), requestId: randomUUID(), previewToken: p.previewToken, confirmed: true };
    await api().post(`/api/v1/trips/${trip.id}/approve-route`).set('Authorization', auth()).send({ ...body, confirmed: false }).expect(400);
    await api().post(`/api/v1/trips/${trip.id}/approve-route`).set('Authorization', auth()).send({ ...body, previewToken: `${p.previewToken}x` }).expect(422);
    const actorId = await f.driver.addEligibleUser();
    const otherActor = jwt.sign({ sub: actorId, email: `${actorId}@example.test`, isSuperAdmin: false, tenantId: f.driver.tenantId, permissions }, f.driver.secret, { expiresIn: 600 });
    await api().post(`/api/v1/trips/${trip.id}/approve-route`).set('Authorization', `Bearer ${otherActor}`).send(body).expect(422);
    const first = await api().post(`/api/v1/trips/${trip.id}/approve-route`).set('Authorization', auth()).send(body).expect(200);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 301000);
    const replay = await api().post(`/api/v1/trips/${trip.id}/approve-route`).set('Authorization', auth()).send(body).expect(200);
    expect(replay.body).toEqual(first.body);
    vi.restoreAllMocks();
    await api().post(`/api/v1/trips/${trip.id}/approve-route`).set('Authorization', `Bearer ${otherActor}`).send(body).expect(409);
    expect(await f.driver.transport.outboxEvent.count({ where: { aggregateId: trip.id, eventType: 'RouteApproved' } })).toBe(1);
  });

  it('creates a reason-bound override approval with unknown metrics and leaves its original immutable', async () => {
    const trip = await draft(), plan = await manual(trip);
    const original = await f.driver.transport.routePlan.findUniqueOrThrow({ where: { id: plan.id } });
    const order = trip.stops.map((stop) => stop.id).reverse();
    const p = await preview(trip, plan, { orderedStopIds: order, reason: 'Customer receiving order' });
    const body = { ...selection(trip, plan), requestId: randomUUID(), previewToken: p.previewToken, confirmed: true, orderedStopIds: order, reason: 'Customer receiving order' };
    await api().post(`/api/v1/trips/${trip.id}/override-route`).set('Authorization', auth()).send({ ...body, reason: 'Different intent' }).expect(422);
    const result = tripSchema.parse((await api().post(`/api/v1/trips/${trip.id}/override-route`).set('Authorization', auth()).send(body).expect(200)).body);
    const selected = tripRoutePlanViewSchema.parse((await api().get(`/api/v1/trips/${trip.id}/route-plans/${result.approvedRoutePlanId}`).set('Authorization', auth()).expect(200)).body);
    expect(selected).toMatchObject({ source: 'OVERRIDE', originalPlanId: plan.id, overrideReason: body.reason, metrics: null, totalDistance: null });
    expect(await f.driver.transport.routePlan.findUniqueOrThrow({ where: { id: plan.id } })).toEqual(original);
  });

  it('rejects stale versions/hash and revoked readiness even before a cancellation projection arrives', async () => {
    const trip = await draft(), plan = await manual(trip), p = await preview(trip, plan);
    const membership = await f.driver.transport.tripShipment.findFirstOrThrow({ where: { tripId: trip.id, state: 'ACTIVE' } });
    await f.fulfillment.shipment.update({ where: { id: membership.shipmentId }, data: { status: 'CANCELED', version: { increment: 1 } } });
    await approve(trip, plan, p.previewToken).expect(409);
    const next = await draft(), oldPlan = await manual(next);
    await api().patch(`/api/v1/trips/${next.id}`).set('Authorization', auth())
      .send({ requestId: randomUUID(), expectedVersion: next.version, plannedStartAt: '2027-03-01T08:00:00.000Z' }).expect(200);
    await api().post(`/api/v1/trips/${next.id}/route-approval-preview`).set('Authorization', auth()).send(selection(next, oldPlan)).expect(409);
  });

  it('retains exact optimizer input across lost HTTP response/restart, rejects mismatched or stale responses and keeps manual usable', async () => {
    const trip = await draft();
    const body = { requestId: randomUUID(), expectedTripVersion: trip.version };
    f.optimizerFault.dropResponse = true;
    await api().post(`/api/v1/trips/${trip.id}/route-optimizations`).set('Authorization', auth()).send(body).expect(503);
    const pending = await f.driver.transport.routePlan.findFirstOrThrow({ where: { tripId: trip.id, routeRequestId: body.requestId } });
    expect(pending.optimizerRequest).not.toBeNull();
    expect((await api().get(`/api/v1/trips/${trip.id}/route-plans`).set('Authorization', auth()).expect(200)).body.items).toHaveLength(0);
    await f.restartTransport();
    const recovered = tripRoutePlanViewSchema.parse((await api().post(`/api/v1/trips/${trip.id}/route-optimizations`).set('Authorization', auth()).send(body).expect(201)).body);
    expect(recovered.id).toBe(pending.id);
    const invalidTrip = await draft();
    f.optimizerFault.corruptHash = true;
    await api().post(`/api/v1/trips/${invalidTrip.id}/route-optimizations`).set('Authorization', auth())
      .send({ requestId: randomUUID(), expectedTripVersion: invalidTrip.version }).expect(422);
    f.optimizerFault.corruptHash = false;
    await manual(invalidTrip);
    const staleTrip = await draft();
    f.optimizerFault.delayResponseMs = 500;
    const inflight = api().post(`/api/v1/trips/${staleTrip.id}/route-optimizations`).set('Authorization', auth())
      .send({ requestId: randomUUID(), expectedTripVersion: staleTrip.version }).then((result) => result);
    await waitFor(async () => (await f.driver.transport.routePlan.count({ where: { tripId: staleTrip.id } })) === 1, 'Optimizer request was not durably recorded before HTTP');
    await api().patch(`/api/v1/trips/${staleTrip.id}`).set('Authorization', auth()).send({
      requestId: randomUUID(), expectedVersion: staleTrip.version, plannedStartAt: '2027-03-02T08:00:00.000Z',
    }).expect(200);
    expect((await inflight).status).toBe(409);
    expect((await api().get(`/api/v1/trips/${staleTrip.id}/route-plans`).set('Authorization', auth()).expect(200)).body.items).toHaveLength(0);
  }, 60000);

  it('enforces route Gateway 401/403/tenant boundaries and non-public internal optimizer calls', async () => {
    const trip = await draft(), plan = await manual(trip);
    for (const [method, suffix, body] of [
      ['get', '/route-plans', undefined],
      ['post', '/route-plans/manual', { requestId: randomUUID(), expectedTripVersion: trip.version, orderedStopIds: trip.stops.map((stop) => stop.id) }],
      ['post', '/route-optimizations', { requestId: randomUUID(), expectedTripVersion: trip.version }],
      ['post', '/route-approval-preview', selection(trip, plan)],
      ['post', '/approve-route', {}], ['post', '/override-route', {}], ['post', '/reopen', {}],
    ] as const) {
      const call = () => method === 'get' ? api().get(`/api/v1/trips/${trip.id}${suffix}`) : api().post(`/api/v1/trips/${trip.id}${suffix}`);
      await call().send(body).expect(401);
      await call().set('Authorization', `Bearer ${f.driver.token(['transport:trip:read'])}`).send(body).expect(403);
    }
    await api().get(`/api/v1/trips/${trip.id}/route-plans`).set('Authorization', `Bearer ${f.driver.token(permissions, f.driver.otherTenantId)}`).expect(404);
    const noAuth = await fetch(new URL(`/api/v1/route-optimizations/${randomUUID()}`, f.optimizerUrl));
    expect(noAuth.status).toBe(401);
  });

  it('invalidates APPROVED on duplicate real ShipmentCanceled events, releases resources and preserves approved evidence', async () => {
    const sharedVehicle = await vehicle(), trip = await draft({ vehicleId: sharedVehicle });
    const plan = await manual(trip), p = await preview(trip, plan);
    const approved = tripSchema.parse((await approve(trip, plan, p.previewToken).expect(200)).body);
    const history = await f.driver.transport.routePlan.findUniqueOrThrow({ where: { id: approved.approvedRoutePlanId! } });
    const event = await canceledShipment(trip);
    await publishCanceled(event);
    await waitFor(async () => {
      const row = await detail(trip.id);
      return row.status === 'DRAFT' && row.stops.some((stop) => stop.deletedAt !== null);
    }, 'Approved route was not invalidated after real ShipmentCanceled');
    const invalidated = await detail(trip.id);
    expect(invalidated.approvedRoutePlanId).toBeNull();
    expect(invalidated.stops.every((stop) => stop.approvedSequence === null)).toBe(true);
    expect(await f.driver.transport.routePlan.findUniqueOrThrow({ where: { id: history.id } })).toEqual(history);
    expect(await f.driver.transport.inboxEvent.count({ where: { eventId: event.eventId } })).toBe(1);
    const next = await draft({ vehicleId: sharedVehicle }), nextPlan = await manual(next), nextPreview = await preview(next, nextPlan);
    await approve(next, nextPlan, nextPreview.previewToken).expect(200);
  }, 60000);

  it('does not consume or free approved resources for an unsafe pending dispatch; recovers the same event after authority rejection', async () => {
    const trip = await draft(), plan = await manual(trip), p = await preview(trip, plan);
    const approved = tripSchema.parse((await approve(trip, plan, p.previewToken).expect(200)).body);
    const dispatch = await f.driver.transport.tripDispatch.create({ data: {
      tenantId: f.driver.tenantId, tripId: trip.id, dispatchVersion: 1n, idempotencyKey: randomUUID(),
      status: 'PENDING', requestedBy: f.driver.userId, requestedAt: new Date(), correlationId: randomUUID(),
    } });
    try {
      const event = await canceledShipment(trip);
      await publishCanceled(event);
      await waitFor(async () => events.some((row) => row.eventId === event.eventId), 'Cancellation did not reach real broker');
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect((await detail(trip.id)).status).toBe('APPROVED');
      expect((await detail(trip.id)).approvedRoutePlanId).toBe(approved.approvedRoutePlanId);
      expect(await f.driver.transport.inboxEvent.count({ where: { eventId: event.eventId } })).toBe(0);
      await f.driver.transport.tripDispatch.update({ where: { id: dispatch.id }, data: { status: 'REJECTED' } });
      await f.restartTransport();
      await waitFor(async () => (await detail(trip.id)).status === 'DRAFT', 'Same pending-dispatch event did not recover after explicit rejection');
    } finally {
      await f.driver.transport.tripDispatch.update({ where: { id: dispatch.id }, data: { status: 'REJECTED' } });
    }
  }, 60000);

  it('retries a real disconnected producer and re-delivers the same eventId after broker ACK / database mark rollback', async () => {
    await f.relay().onModuleDestroy();
    const producer = new KafkaProducerService(f.broker.kafka);
    const store = new PrismaOutboxStore(f.driver.transport, 'transport', ServiceId.TRANSPORT_SERVICE, 30000);
    const relayOptions = { topic: f.broker.topic, intervalMs: 100, batchSize: 100, retryBaseMs: 100, retryMaxMs: 1000 };
    try {
      await producer.onModuleInit();
      const normalRelay = new OutboxRelay(store, producer, relayOptions);
      for (let index = 0; index < 10; index++) await normalRelay.flush();
      const trip = await draft(), plan = await manual(trip), p = await preview(trip, plan), commandId = randomUUID();
      await approve(trip, plan, p.previewToken, commandId).expect(200);
      const event = await f.driver.transport.outboxEvent.findFirstOrThrow({ where: { aggregateId: trip.id, eventType: 'RouteApproved' } });
      await producer.onModuleDestroy();
      await normalRelay.flush();
      expect((await f.driver.transport.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).publishedAt).toBeNull();
      expect((await f.driver.transport.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).attemptCount).toBe(1);
      await producer.onModuleInit();
      await new Promise((resolve) => setTimeout(resolve, 150));
      const brokenMarkRelay = new OutboxRelay({
        withLockedBatch: (size, callback) => store.withLockedBatch(size, (records, tx) =>
          callback(records, { ...tx, markPublished: async (id, timestamp) => {
            await tx.markPublished(id, timestamp);
            if (id === event.id) throw new Error('Owned fault after publish ACK and mark before transaction commit');
          } })),
      }, producer, relayOptions);
      await expect(brokenMarkRelay.flush()).rejects.toThrow('Owned fault');
      expect((await f.driver.transport.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).publishedAt).toBeNull();
      await normalRelay.flush();
      await waitFor(async () => events.filter((row) => row.eventId === event.id).length >= 2, 'Broker did not receive replay with the same durable eventId');
      expect((await f.driver.transport.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).publishedAt).not.toBeNull();
    } finally {
      await producer.onModuleDestroy();
      f.relay().onModuleInit();
    }
  }, 60000);

  it('uses actual Agent Python tools for optimize/read/backend-preview/confirmed approval through Gateway without fabricated versions', async () => {
    const trip = await draft();
    const python = process.env.ROUTE_OPTIMIZER_TEST_PYTHON;
    if (!python) throw new Error('Owned Python environment is required');
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const script = path.join(root, 'apps', 'agent-service', 'tests', 'support', 'route_gateway_probe.py');
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(python, [script], {
        cwd: root, env: { ...process.env,
          PYTHONPATH: path.join(root, 'apps', 'agent-service', 'src'),
          PHASE3_AGENT_ACCESS_TOKEN: f.driver.token(permissions),
        }, stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.once('error', reject);
      child.once('exit', (code) => code === 0 ? resolve(stdout) : reject(new Error(`Owned Agent probe failed: ${stderr}`)));
      child.stdin.end(JSON.stringify({ gatewayUrl: f.url, actorId: f.driver.userId, tenantId: f.driver.tenantId, tripId: trip.id, tripVersion: trip.version }));
    });
    const result = z.object({
      plan: z.object({ id: z.string().uuid(), optimizationRunId: z.string().uuid(), planVersion: z.number() }).passthrough(),
      comparison: z.record(z.string(), z.unknown()), preview: z.record(z.string(), z.unknown()),
      approved: z.object({ id: z.string().uuid(), approvedRoutePlanId: z.string().uuid(), status: z.literal('APPROVED'), version: z.number() }),
    }).parse(JSON.parse(output));
    expect(result.plan.id).not.toBe(result.plan.optimizationRunId);
    expect(result.plan.optimizationRunId).not.toBe(trip.id);
    expect(result.preview).not.toHaveProperty('previewToken');
    expect(result.preview.planVersion).toBe(result.plan.planVersion);
    expect(result.approved.id).toBe(trip.id);
    expect(result.approved.version).toBe(trip.version + 1);
    expect((await detail(trip.id)).approvedRoutePlanId).toBe(result.approved.approvedRoutePlanId);
  }, 60000);
});
