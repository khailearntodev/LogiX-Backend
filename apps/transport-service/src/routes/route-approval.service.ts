import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from '@logix/auth';
import { BusinessRuleViolationError, EntityNotFoundError } from '@logix/errors';
import type { ApproveTripRoute, OverrideTripRoute, ReopenTrip, TripRoutePreview } from '@logix/messaging';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { TripQueryService } from '../trips/trip-query.service.js';
import { TripConflictError } from '../trips/trip-conflict.error.js';
import { stableHash, toSafeVersion } from '../trips/trip-serialization.js';
import { assertPermutation, jsonValue, mapResourceConflict, routeTrip } from './route-domain.js';
import { RouteInputService, type CurrentRouteInput } from './route-input.service.js';
import { nextPlanVersion, planSource, type PlanWithStops } from './route-plan.service.js';
import { RoutePreviewTokenService } from './route-preview-token.service.js';

@Injectable()
export class RouteApprovalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inputs: RouteInputService,
    private readonly previews: RoutePreviewTokenService,
    private readonly queries: TripQueryService,
  ) {}

  async preview(user: AuthenticatedUser, tripId: string, dto: TripRoutePreview, authorization: string) {
    const context = await this.inputs.current(user.tenantId, tripId, authorization);
    const { plan, orderedStopIds } = await this.validate(context, dto);
    await this.prisma.$transaction((tx) => routeTrip(tx, user.tenantId, tripId, dto.expectedVersion));
    const selection = {
      expectedVersion: dto.expectedVersion, planId: dto.planId, planVersion: dto.planVersion,
      inputHash: dto.inputHash, orderedStopIds, reason: dto.reason ?? null,
    };
    const action = dto.orderedStopIds ? 'OVERRIDE' : 'APPROVE';
    return {
      ...this.previews.issue({
        tenantId: user.tenantId, actorId: user.id, tripId, action,
        payloadHash: this.previewHash(selection, context),
      }),
      tripId, ...selection, action,
      vehicleSnapshot: context.vehicleSnapshot, driverSnapshot: context.driverSnapshot,
      totalWeight: context.trip.totalWeight.toFixed(3), totalVolume: context.trip.totalVolume.toFixed(6),
      planId: plan.id,
    };
  }

  async approve(user: AuthenticatedUser, tripId: string, dto: ApproveTripRoute | OverrideTripRoute, authorization: string) {
    const action = 'orderedStopIds' in dto ? 'OVERRIDE' : 'APPROVE';
    const commandHash = stableHash({ action, tripId, ...dto });
    const existing = await this.receipt(user, tripId, dto.requestId, commandHash);
    if (existing) return existing;
    const context = await this.inputs.current(user.tenantId, tripId, authorization);
    const { plan, orderedStopIds } = await this.validate(context, dto);
    this.previews.verify(dto.previewToken, {
      tenantId: user.tenantId, actorId: user.id, tripId, action,
      payloadHash: this.previewHash({
        expectedVersion: dto.expectedVersion, planId: dto.planId, planVersion: dto.planVersion,
        inputHash: dto.inputHash, orderedStopIds, reason: 'reason' in dto ? dto.reason : null,
      }, context),
    });
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Serialize competing confirmations and return committed receipts before state checks.
        await tx.$queryRaw`SELECT id FROM transport.delivery_trips WHERE id = ${tripId}::uuid AND tenant_id = ${user.tenantId}::uuid FOR UPDATE`;
        const replay = await this.receipt(user, tripId, dto.requestId, commandHash, tx);
        if (replay) return replay;
        const trip = await routeTrip(tx, user.tenantId, tripId, dto.expectedVersion);
        if (trip.stops.length !== orderedStopIds.length || trip.shipments.some((row) => row.state !== 'ACTIVE'))
          throw new TripConflictError('TRIP_MANIFEST_CHANGED');
        assertPermutation(orderedStopIds, trip.stops.map((stop) => stop.id));
        const approvedAt = new Date();
        const approved = await tx.routePlan.create({
          data: {
            tenantId: user.tenantId, tripId,
            planVersion: await nextPlanVersion(tx, user.tenantId, tripId),
            routeRequestId: randomUUID(), source: action === 'OVERRIDE' ? 'OVERRIDE' : planSource(plan.source),
            inputHash: context.hash, inputSnapshot: jsonValue(context.input),
            optimizationRunId: action === 'OVERRIDE' ? null : plan.optimizationRunId,
            solverName: action === 'OVERRIDE' ? null : plan.solverName,
            solverVersion: action === 'OVERRIDE' ? null : plan.solverVersion,
            objective: action === 'OVERRIDE' ? null : plan.objective,
            totalDistance: action === 'OVERRIDE' ? null : plan.totalDistance,
            estimatedCost: action === 'OVERRIDE' ? null : plan.estimatedCost,
            metrics: action === 'OVERRIDE' || plan.metrics === null ? Prisma.DbNull : jsonValue(plan.metrics),
            optimizerResponse: action === 'OVERRIDE' || plan.optimizerResponse === null ? Prisma.DbNull : jsonValue(plan.optimizerResponse),
            originalPlanId: plan.id, overrideReason: 'reason' in dto ? dto.reason : plan.overrideReason,
            approvedBy: user.id, approvedAt,
            vehicleSnapshot: jsonValue(context.vehicleSnapshot), driverSnapshot: jsonValue(context.driverSnapshot),
            approvalRequestId: dto.requestId, approvalHash: commandHash,
            stops: {
              create: orderedStopIds.map((tripStopId, index) => {
                const old = plan.stops.find((stop) => stop.tripStopId === tripStopId);
                return {
                  tenantId: user.tenantId, tripStopId, sequence: index + 1,
                  distanceFromPrevious: action === 'OVERRIDE' ? null : old?.distanceFromPrevious,
                  cumulativeDistance: action === 'OVERRIDE' ? null : old?.cumulativeDistance,
                  estimatedArrivalAt: action === 'OVERRIDE' ? null : old?.estimatedArrivalAt,
                  legDurationSeconds: action === 'OVERRIDE' ? null : old?.legDurationSeconds,
                };
              }),
            },
          },
        });
        // Clear first: exchanging 1/2 in-place would violate the partial unique index mid-transaction.
        await tx.tripStop.updateMany({ where: { tenantId: user.tenantId, tripId }, data: { approvedSequence: null } });
        for (const [index, stopId] of orderedStopIds.entries()) {
          await tx.tripStop.update({ where: { id: stopId }, data: { approvedSequence: index + 1, version: { increment: 1 } } });
        }
        const updated = await tx.deliveryTrip.update({
          where: { id: tripId },
          data: {
            status: 'APPROVED', approvedRoutePlanId: approved.id,
            vehicleSnapshot: jsonValue(context.vehicleSnapshot), driverSnapshot: jsonValue(context.driverSnapshot),
            version: { increment: 1 },
          },
        });
        await tx.outboxEvent.create({
          data: {
            tenantId: user.tenantId, eventType: 'RouteApproved', eventVersion: 2,
            aggregateType: 'DeliveryTrip', aggregateId: tripId, aggregateVersion: updated.version,
            correlationId: dto.requestId, causationId: dto.requestId, occurredAt: approvedAt,
            payload: {
              contractVersion: 1, actorId: user.id, tenantId: user.tenantId, tripId,
              routePlanId: approved.id, originalPlanId: plan.id, source: approved.source,
              planVersion: toSafeVersion(approved.planVersion), inputHash: context.hash,
              requestId: dto.requestId, action, reason: 'reason' in dto ? dto.reason : null,
              approvedAt: approvedAt.toISOString(), vehicleId: trip.vehicleId, driverId: trip.driverId,
              before: { status: trip.status, version: toSafeVersion(trip.version) },
              after: { status: updated.status, version: toSafeVersion(updated.version) },
            },
          },
        });
        const response = await this.queries.get(user.tenantId, tripId, tx);
        if (!response) throw new EntityNotFoundError('DeliveryTrip', tripId);
        await tx.routePlan.update({ where: { id: approved.id }, data: { approvalReceipt: jsonValue(response) } });
        return response;
      });
    } catch (error) {
      const replay = await this.receipt(user, tripId, dto.requestId, commandHash);
      if (replay) return replay;
      mapResourceConflict(error);
    }
  }

  async reopen(user: AuthenticatedUser, tripId: string, dto: ReopenTrip) {
    return this.prisma.$transaction(async (tx) => {
      const trip = await routeTrip(tx, user.tenantId, tripId, dto.expectedVersion, 'APPROVED');
      await tx.tripStop.updateMany({ where: { tenantId: user.tenantId, tripId }, data: { approvedSequence: null, version: { increment: 1 } } });
      const updated = await tx.deliveryTrip.update({
        where: { id: tripId },
        data: { status: 'DRAFT', approvedRoutePlanId: null, version: { increment: 1 } },
      });
      await tx.outboxEvent.create({
        data: {
          tenantId: user.tenantId, eventType: 'TripReopened', eventVersion: 1,
          aggregateType: 'DeliveryTrip', aggregateId: tripId, aggregateVersion: updated.version,
          correlationId: dto.requestId, causationId: dto.requestId, occurredAt: new Date(),
          payload: {
            actorId: user.id, tenantId: user.tenantId, tripId, requestId: dto.requestId,
            reason: dto.reason, previousRoutePlanId: trip.approvedRoutePlanId,
            before: { status: trip.status, version: toSafeVersion(trip.version) },
            after: { status: updated.status, version: toSafeVersion(updated.version) },
          },
        },
      });
      return this.queries.get(user.tenantId, tripId, tx);
    });
  }

  private previewHash(selection: unknown, context: CurrentRouteInput) {
    return stableHash({ selection, vehicleSnapshot: context.vehicleSnapshot, driverSnapshot: context.driverSnapshot });
  }
  private async validate(context: CurrentRouteInput, dto: TripRoutePreview) {
    const plan = await this.prisma.routePlan.findFirst({
      where: { id: dto.planId, tenantId: context.trip.tenantId, tripId: context.trip.id, deletedAt: null }, include: { stops: true },
    });
    if (!plan || !plan.stops.length) throw new EntityNotFoundError('RoutePlan', dto.planId);
    if (toSafeVersion(plan.planVersion) !== dto.planVersion || plan.inputHash !== dto.inputHash || context.hash !== plan.inputHash)
      throw new TripConflictError('ROUTE_INPUT_OR_PLAN_CHANGED');
    if (plan.source === 'OPTIMIZED' && !plan.optimizationRunId)
      throw new BusinessRuleViolationError('OPTIMIZER_RESULT_NOT_PERSISTED');
    const orderedStopIds = dto.orderedStopIds ?? [...plan.stops].sort((a, b) => a.sequence - b.sequence).map((stop) => stop.tripStopId);
    assertPermutation(orderedStopIds, context.input.stops.map((stop) => stop.stopId));
    return { plan: plan as PlanWithStops, orderedStopIds };
  }
  private async receipt(user: AuthenticatedUser, tripId: string, requestId: string, hash: string, tx: Prisma.TransactionClient = this.prisma) {
    const prior = await tx.routePlan.findFirst({ where: { tenantId: user.tenantId, approvalRequestId: requestId } });
    if (!prior) return null;
    if (prior.tripId !== tripId || prior.approvedBy !== user.id || prior.approvalHash !== hash || prior.approvalReceipt === null)
      throw new TripConflictError('ROUTE_APPROVAL_REPLAY_CONFLICT');
    return prior.approvalReceipt;
  }
}
