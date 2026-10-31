import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from '@logix/auth';
import { BusinessRuleViolationError } from '@logix/errors';
import {
  assertBatchDispatchGrantBinding, batchDispatchGrantRequestSchema,
  hashTransportContractPayload, shipmentDispatchBatchReceiptSchema,
  tripDispatchedPayloadV2Schema, tripDispatchOperationSchema,
  type TripDispatchCommand, type BatchDispatchGrantRequest,
} from '@logix/messaging';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { FulfillmentClient } from '../integrations/fulfillment.client.js';
import { RouteInputService } from '../routes/route-input.service.js';
import { RoutePreviewTokenService } from '../routes/route-preview-token.service.js';
import { assertPermutation, jsonValue, lockTrip, routeHash, routeTrip } from '../routes/route-domain.js';
import { stableHash, toSafeVersion } from '../trips/trip-serialization.js';
import { TripConflictError } from '../trips/trip-conflict.error.js';

const DISPATCH_RETRY_BASE_MS = 1_000;
const DISPATCH_RETRY_MAX_MS = 60_000;

@Injectable()
export class TripDispatchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inputs: RouteInputService,
    private readonly previews: RoutePreviewTokenService,
    private readonly fulfillment: FulfillmentClient,
  ) {}

  async preview(user: AuthenticatedUser, tripId: string, version: number) {
    const selection = await this.selection(user.tenantId, tripId, version);
    await this.prisma.$transaction((tx) => routeTrip(tx, user.tenantId, tripId, version, 'APPROVED'));
    return {
      tripId, version, approvedPlanId: selection.approvedPlanId, inputHash: selection.inputHash,
      dispatchVersion: selection.dispatchVersion, shipmentCount: selection.shipments.length,
      ...this.previews.issue({
        tenantId: user.tenantId, actorId: user.id, tripId, action: 'DISPATCH',
        payloadHash: stableHash(selection),
      }),
    };
  }

  async dispatch(user: AuthenticatedUser, tripId: string, dto: TripDispatchCommand) {
    const hash = stableHash({ tripId, ...dto });
    const prior = await this.replay(user, tripId, dto.requestId, hash);
    if (prior) {
      await this.resume(user.tenantId, dto.requestId);
      return this.operation(user.tenantId, tripId, dto.requestId);
    }
    const selection = await this.selection(user.tenantId, tripId, dto.version);
    this.previews.verify(dto.previewToken, {
      tenantId: user.tenantId, actorId: user.id, tripId, action: 'DISPATCH', payloadHash: stableHash(selection),
    });
    const payload: BatchDispatchGrantRequest = batchDispatchGrantRequestSchema.parse({
      contractVersion: 1, tenantId: user.tenantId, requestId: dto.requestId, tripId, actorId: user.id,
      expectedTripVersion: dto.version, approvedPlanId: selection.approvedPlanId,
      dispatchVersion: selection.dispatchVersion, inputHash: selection.inputHash,
      shipments: selection.shipments.map((item) => ({ ...item, dispatchRequestId: randomUUID() })),
    });
    await this.prisma.$transaction(async (tx) => {
      await lockTrip(tx, user.tenantId, tripId);
      if (await this.replay(user, tripId, dto.requestId, hash, tx)) return;
      await routeTrip(tx, user.tenantId, tripId, dto.version, 'APPROVED');
      const existingKey = await tx.tripOperation.findFirst({ where: { tenantId: user.tenantId, requestId: dto.requestId } });
      if (existingKey) throw new TripConflictError('TRIP_REQUEST_ID_ALREADY_USED');
      await tx.tripDispatch.create({
        data: {
          tenantId: user.tenantId, tripId, dispatchVersion: BigInt(selection.dispatchVersion),
          idempotencyKey: dto.requestId, status: 'PENDING', stage: 'ACCEPTED', requestedBy: user.id,
          requestedAt: new Date(), correlationId: dto.requestId, payloadHash: hash,
          command: dto, payload: jsonValue(payload),
        },
      });
    });
    await this.resume(user.tenantId, dto.requestId);
    return this.operation(user.tenantId, tripId, dto.requestId);
  }

  async operation(tenantId: string, tripId: string, requestId: string) {
    const row = await this.prisma.tripDispatch.findFirst({ where: { tenantId, tripId, idempotencyKey: requestId } });
    if (!row) return null;
    const trip = await this.prisma.deliveryTrip.findFirstOrThrow({ where: { tenantId, id: tripId } });
    const payload = batchDispatchGrantRequestSchema.parse(row.payload);
    return tripDispatchOperationSchema.parse({
      tripId, requestId, kind: 'DISPATCH', status: row.status, stage: row.stage,
      payloadHash: row.payloadHash, version: toSafeVersion(trip.version),
      result: row.result, error: row.lastError,
      nextRetryAt: row.status === 'PENDING' ? row.nextAttemptAt.toISOString() : null,
      results: payload.shipments.map((item) => ({ shipmentId: item.shipmentId, state: row.status })),
    });
  }

  async resume(tenantId: string, requestId: string) {
    const row = await this.prisma.tripDispatch.findFirst({ where: { tenantId, idempotencyKey: requestId } });
    if (!row || row.status !== 'PENDING') return;
    const parsed = batchDispatchGrantRequestSchema.safeParse(row.payload);
    if (!parsed.success) {
      await this.prisma.tripDispatch.updateMany({
        where: { id: row.id, status: 'PENDING' },
        data: { lastError: 'DISPATCH_LEGACY_INTENT_REQUIRES_RECONCILIATION',
          attemptCount: { increment: 1 }, nextAttemptAt: new Date(Date.now() + DISPATCH_RETRY_MAX_MS) },
      });
      return;
    }
    const payload = parsed.data;
    try {
      if (row.stage === 'ACCEPTED') {
        // This stage proves no cross-service mutation has been attempted.
        const current = await this.selection(tenantId, row.tripId, payload.expectedTripVersion, payload.dispatchVersion);
        const expected = {
          approvedPlanId: payload.approvedPlanId, inputHash: payload.inputHash,
          dispatchVersion: payload.dispatchVersion,
          shipments: payload.shipments.map(({ dispatchRequestId: _child, ...item }) => item),
        };
        if (stableHash(current) !== stableHash(expected)) throw new TripConflictError('DISPATCH_INPUT_CHANGED');
        await this.prisma.$transaction(async (tx) => {
          await lockTrip(tx, tenantId, row.tripId);
          const trip = await tx.deliveryTrip.findFirstOrThrow({ where: { tenantId, id: row.tripId } });
          if (trip.status !== 'APPROVED' || trip.version !== BigInt(payload.expectedTripVersion) ||
            trip.approvedRoutePlanId !== payload.approvedPlanId)
            throw new TripConflictError('DISPATCH_INPUT_CHANGED');
          await tx.tripDispatch.updateMany({
            where: { id: row.id, status: 'PENDING', stage: 'ACCEPTED' }, data: { stage: 'SUBMITTED' },
          });
        });
      }
      const receipt = row.receipt
        ? shipmentDispatchBatchReceiptSchema.parse(row.receipt)
        : await this.fulfillment.dispatchBatch(payload);
      if (receipt.tenantId !== tenantId || receipt.tripId !== row.tripId || receipt.requestId !== requestId ||
        receipt.payloadHash !== hashTransportContractPayload(payload))
        throw new Error('Mismatched Fulfillment dispatch receipt');
      if (receipt.decision) assertBatchDispatchGrantBinding(payload, receipt.decision);
      if (receipt.status === 'PENDING') return;
      if (receipt.status === 'REJECTED') {
        await this.prisma.tripDispatch.updateMany({
          where: { id: row.id, status: 'PENDING' },
          data: { receipt: jsonValue(receipt), stage: 'REJECTED', status: 'REJECTED', lastError: receipt.decision?.decision === 'REJECTED' ? receipt.decision.reasonCode : 'FULFILLMENT_REJECTED' },
        });
        return;
      }
      if (receipt.decision?.decision !== 'GRANTED' || receipt.shipments.length !== payload.shipments.length ||
        payload.shipments.some((item) => !receipt.shipments.some((child) => child.shipmentId === item.shipmentId &&
          child.dispatchRequestId === item.dispatchRequestId && child.shipmentVersion === item.shipmentVersion + 1)))
        throw new Error('Incomplete Fulfillment dispatch receipt');
      await this.prisma.tripDispatch.updateMany({
        where: { id: row.id, status: 'PENDING' }, data: { stage: 'RECEIPTED', receipt: jsonValue(receipt) },
      });
      await this.commit(tenantId, requestId);
    } catch (error) {
      const latest = await this.prisma.tripDispatch.findUniqueOrThrow({ where: { id: row.id } });
      const beforeSubmit = latest.stage === 'ACCEPTED' &&
        (error instanceof BusinessRuleViolationError || error instanceof TripConflictError);
      await this.prisma.tripDispatch.updateMany({
        where: { id: row.id, status: 'PENDING' },
        data: {
          ...(beforeSubmit ? { status: 'REJECTED', stage: 'REJECTED' } : {}),
          attemptCount: { increment: 1 }, lastError: beforeSubmit ? 'DISPATCH_PRECONDITION_CHANGED' : 'DISPATCH_RECOVERY_PENDING',
          nextAttemptAt: new Date(Date.now() + Math.min(DISPATCH_RETRY_MAX_MS,
            DISPATCH_RETRY_BASE_MS * 2 ** Math.min(row.attemptCount, 6))),
        },
      });
    }
  }

  async commit(tenantId: string, requestId: string) {
    const row = await this.prisma.tripDispatch.findFirstOrThrow({ where: { tenantId, idempotencyKey: requestId } });
    const payload = batchDispatchGrantRequestSchema.parse(row.payload);
    await this.prisma.$transaction(async (tx) => {
        await lockTrip(tx, tenantId, row.tripId);
        const dispatch = await tx.tripDispatch.findUniqueOrThrow({ where: { id: row.id } });
        if (dispatch.status === 'COMPLETED') return;
        if (dispatch.status !== 'PENDING' || !dispatch.receipt) throw new Error('Dispatch receipt lost');
        const trip = await tx.deliveryTrip.findFirstOrThrow({ where: { tenantId, id: row.tripId } });
        if (trip.status !== 'APPROVED' || trip.approvedRoutePlanId !== payload.approvedPlanId ||
          trip.version !== BigInt(payload.expectedTripVersion)) throw new Error('Granted trip binding changed');
        const now = new Date();
        const updated = await tx.deliveryTrip.update({
          where: { id: row.tripId },
          data: { status: 'IN_PROGRESS', actualStartAt: now, dispatchedAt: now,
            dispatchVersion: BigInt(payload.dispatchVersion), version: { increment: 1 } },
        });
        const result = {
          tripId: trip.id, status: 'IN_PROGRESS', version: toSafeVersion(updated.version),
          dispatchVersion: payload.dispatchVersion, dispatchedAt: now.toISOString(),
        };
        await tx.tripDispatch.update({ where: { id: row.id }, data: {
          status: 'COMPLETED', stage: 'COMPLETED', result, completedAt: now, lastError: null,
        } });
        const event = tripDispatchedPayloadV2Schema.parse({
          contractVersion: 1, tenantId, tripId: trip.id, warehouseId: trip.warehouseId,
          dispatchVersion: payload.dispatchVersion, dispatchRequestId: requestId, approvedPlanId: payload.approvedPlanId,
          driverId: trip.driverId, assigneeUserId: trip.driverUserId, vehicleId: trip.vehicleId,
          dispatchedAt: now.toISOString(),
          shipments: payload.shipments.map(({ shipmentId, orderId, reservationGroupId, orderVersion }) =>
            ({ shipmentId, orderId, reservationGroupId, orderVersion })),
        });
        await tx.outboxEvent.create({ data: {
          tenantId, eventType: 'TripDispatched', eventVersion: 2, aggregateType: 'DeliveryTrip',
          aggregateId: trip.id, aggregateVersion: updated.version, correlationId: requestId,
          causationId: requestId, occurredAt: now, payload: { ...event, actorId: row.requestedBy },
        } });
      });
  }

  private async selection(tenantId: string, tripId: string, version: number, dispatchVersion?: number) {
    const context = await this.inputs.current(tenantId, tripId);
    const trip = context.trip;
    if (trip.status !== 'APPROVED' || trip.version !== BigInt(version) || !trip.approvedRoutePlanId)
      throw new TripConflictError('TRIP_NOT_APPROVED_OR_VERSION_CHANGED');
    const plan = await this.prisma.routePlan.findFirst({
      where: { id: trip.approvedRoutePlanId, tenantId, tripId }, include: { stops: true },
    });
    if (!plan || !plan.approvedAt || !plan.inputSnapshot || typeof plan.inputSnapshot !== 'object' || Array.isArray(plan.inputSnapshot))
      throw new TripConflictError('ROUTE_INPUT_OR_PLAN_CHANGED');
    const input = { ...context.input, tripVersion: plan.inputSnapshot.tripVersion };
    if (routeHash(input) !== plan.inputHash) throw new TripConflictError('ROUTE_INPUT_OR_PLAN_CHANGED');
    assertPermutation(plan.stops.map((stop) => stop.tripStopId), trip.stops.map((stop) => stop.id));
    if (plan.stops.some((stop) => trip.stops.find((item) => item.id === stop.tripStopId)?.approvedSequence !== stop.sequence))
      throw new TripConflictError('ROUTE_SEQUENCE_CHANGED');
    const resources = await this.prisma.deliveryTrip.count({
      where: { tenantId, status: { in: ['APPROVED', 'IN_PROGRESS'] },
        OR: [{ vehicleId: trip.vehicleId }, { driverId: trip.driverId }] },
    });
    if (resources !== 1) throw new TripConflictError('TRIP_RESOURCE_CONFLICT');
    const shipments = await this.fulfillment.dispatchReadiness(tenantId, tripId,
      trip.shipments.map((item) => ({ shipmentId: item.shipmentId, shipmentVersion: toSafeVersion(item.shipmentVersion!) })));
    if (shipments.length !== trip.shipments.length || shipments.some((item, index) =>
      item.shipmentId !== trip.shipments[index]?.shipmentId || item.orderId !== trip.shipments[index]?.orderId))
      throw new TripConflictError('SHIPMENT_READINESS_BINDING_CHANGED');
    const previous = dispatchVersion === undefined
      ? await this.prisma.tripDispatch.aggregate({ where: { tenantId, tripId }, _max: { dispatchVersion: true } })
      : null;
    return {
      approvedPlanId: plan.id, inputHash: plan.inputHash,
      dispatchVersion: dispatchVersion ?? Number(previous?._max.dispatchVersion ?? trip.dispatchVersion) + 1,
      shipments,
    };
  }

  private async replay(user: AuthenticatedUser, tripId: string, requestId: string, hash: string, tx: Prisma.TransactionClient = this.prisma) {
    const prior = await tx.tripDispatch.findFirst({ where: { tenantId: user.tenantId, idempotencyKey: requestId } });
    if (prior && (prior.tripId !== tripId || prior.requestedBy !== user.id || prior.payloadHash !== hash))
      throw new TripConflictError('TRIP_DISPATCH_REPLAY_CONFLICT');
    return prior;
  }
}
