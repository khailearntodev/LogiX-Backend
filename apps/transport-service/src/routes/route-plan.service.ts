import { Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from '@logix/auth';
import { BusinessRuleViolationError, EntityNotFoundError } from '@logix/errors';
import { tripRoutePlanViewSchema, type ManualTripRoute, type OptimizeTripRoute } from '@logix/messaging';
import { Prisma, type RoutePlan, type RoutePlanStop } from '../generated/prisma/client.js';
import { PrismaService } from '../database/prisma.service.js';
import { TripConflictError } from '../trips/trip-conflict.error.js';
import { stableHash, toSafeVersion } from '../trips/trip-serialization.js';
import { assertPermutation, jsonValue, mapResourceConflict, routeTrip } from './route-domain.js';
import { RouteInputService } from './route-input.service.js';
import { OptimizerClient, optimizerRequest } from './optimizer.client.js';

export type PlanWithStops = RoutePlan & { stops: RoutePlanStop[] };
export function planSource(source: string) {
  if (source === 'OPTIMIZER') return 'OPTIMIZED';
  if (source === 'MANUAL_OVERRIDE') return 'OVERRIDE';
  return source;
}
export function planView(plan: PlanWithStops) {
  return tripRoutePlanViewSchema.parse({
    id: plan.id, tenantId: plan.tenantId, tripId: plan.tripId,
    planVersion: toSafeVersion(plan.planVersion), version: toSafeVersion(plan.version),
    routeRequestId: plan.routeRequestId, source: planSource(plan.source), inputHash: plan.inputHash,
    inputSnapshot: plan.inputSnapshot, optimizationRunId: plan.optimizationRunId,
    solverName: plan.solverName, solverVersion: plan.solverVersion, objective: plan.objective,
    totalDistance: plan.totalDistance?.toFixed(3) ?? null, estimatedCost: plan.estimatedCost?.toFixed(2) ?? null,
    metrics: plan.metrics, originalPlanId: plan.originalPlanId, overrideReason: plan.overrideReason,
    approvedBy: plan.approvedBy, approvedAt: plan.approvedAt?.toISOString() ?? null,
    vehicleSnapshot: plan.vehicleSnapshot, driverSnapshot: plan.driverSnapshot, createdAt: plan.createdAt.toISOString(),
    stops: [...plan.stops].sort((a, b) => a.sequence - b.sequence).map((stop) => ({
      tripStopId: stop.tripStopId, sequence: stop.sequence,
      eta: stop.estimatedArrivalAt?.toISOString() ?? null,
      legDistance: stop.distanceFromPrevious?.toFixed(3) ?? null,
      legDurationSeconds: stop.legDurationSeconds,
    })),
  });
}

export async function nextPlanVersion(tx: Prisma.TransactionClient, tenantId: string, tripId: string) {
  const latest = await tx.routePlan.findFirst({ where: { tenantId, tripId }, orderBy: { planVersion: 'desc' }, select: { planVersion: true } });
  const value = (latest?.planVersion ?? 0n) + 1n;
  toSafeVersion(value);
  return value;
}

@Injectable()
export class RoutePlanService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inputs: RouteInputService,
    private readonly optimizer: OptimizerClient,
  ) {}

  async list(tenantId: string, tripId: string) {
    await this.requireTrip(tenantId, tripId);
    const plans = await this.prisma.routePlan.findMany({
      where: { tenantId, tripId, deletedAt: null, stops: { some: {} } },
      include: { stops: true }, orderBy: { planVersion: 'desc' },
    });
    return { items: plans.map(planView) };
  }
  async get(tenantId: string, tripId: string, planId: string) {
    const plan = await this.prisma.routePlan.findFirst({
      where: { id: planId, tenantId, tripId, deletedAt: null, stops: { some: {} } }, include: { stops: true },
    });
    if (!plan) throw new EntityNotFoundError('RoutePlan', planId);
    return planView(plan);
  }
  async manual(user: AuthenticatedUser, tripId: string, dto: ManualTripRoute, authorization: string) {
    const hash = stableHash({ kind: 'MANUAL', tripId, ...dto });
    const existing = await this.replay(user, tripId, dto.requestId, hash);
    if (existing) return planView(existing);
    const context = await this.inputs.current(user.tenantId, tripId, authorization);
    assertPermutation(dto.orderedStopIds, context.input.stops.map((stop) => stop.stopId));
    try {
      return await this.prisma.$transaction(async (tx) => {
        await routeTrip(tx, user.tenantId, tripId, dto.expectedTripVersion);
        const replay = await this.replay(user, tripId, dto.requestId, hash, tx);
        if (replay) return planView(replay);
        if (context.input.tripVersion !== dto.expectedTripVersion) throw new TripConflictError('ROUTE_INPUT_CHANGED');
        const plan = await tx.routePlan.create({
          data: {
            tenantId: user.tenantId, tripId, planVersion: await nextPlanVersion(tx, user.tenantId, tripId),
            routeRequestId: dto.requestId, requestActorId: user.id, requestHash: hash,
            source: 'MANUAL', inputHash: context.hash, inputSnapshot: jsonValue(context.input),
            stops: { create: dto.orderedStopIds.map((tripStopId, index) => ({ tenantId: user.tenantId, tripStopId, sequence: index + 1 })) },
          }, include: { stops: true },
        });
        return planView(plan);
      });
    } catch (error) {
      const replay = await this.replay(user, tripId, dto.requestId, hash);
      if (replay) return planView(replay);
      mapResourceConflict(error);
    }
  }

  async optimize(user: AuthenticatedUser, tripId: string, dto: OptimizeTripRoute, authorization: string) {
    const hash = stableHash({ kind: 'OPTIMIZED', tripId, ...dto });
    let pending = await this.replay(user, tripId, dto.requestId, hash);
    if (pending?.stops.length) return planView(pending);
    if (!pending) {
      const context = await this.inputs.current(user.tenantId, tripId, authorization);
      pending = await this.prisma.$transaction(async (tx) => {
        await routeTrip(tx, user.tenantId, tripId, dto.expectedTripVersion);
        const replay = await this.replay(user, tripId, dto.requestId, hash, tx);
        if (replay) return replay;
        if (context.input.tripVersion !== dto.expectedTripVersion) throw new TripConflictError('ROUTE_INPUT_CHANGED');
        // A request envelope is not a valid proposal until its response and full stops commit.
        return tx.routePlan.create({
          data: {
            tenantId: user.tenantId, tripId, planVersion: await nextPlanVersion(tx, user.tenantId, tripId),
            routeRequestId: dto.requestId, requestActorId: user.id, requestHash: hash,
            source: 'OPTIMIZED', inputHash: context.hash, inputSnapshot: jsonValue(context.input),
            optimizerRequest: jsonValue(optimizerRequest(context.input, dto.requestId, context.hash)),
          }, include: { stops: true },
        });
      });
    }
    let result;
    try {
      result = await this.optimizer.compute(user.tenantId, pending.optimizerRequest);
    } catch (error) {
      await this.prisma.routePlan.updateMany({
        where: { id: pending.id, stops: { none: {} } },
        data: { optimizerResponse: { failedAt: new Date().toISOString(), code: 'OPTIMIZER_CALL_FAILED' } },
      });
      throw error;
    }
    if (result.tenant_id !== user.tenantId || result.trip_id !== tripId ||
      result.route_request_id !== dto.requestId || result.trip_version !== dto.expectedTripVersion ||
      result.input_hash !== pending.inputHash || result.route_plan_id === tripId || result.route_plan_id === pending.id ||
      result.objective !== 'MINIMIZE_ROAD_DISTANCE' || !result.config_version.startsWith('route-v1;'))
      throw new BusinessRuleViolationError('OPTIMIZER_RESPONSE_BINDING_MISMATCH');
    const fresh = await this.inputs.current(user.tenantId, tripId, authorization);
    if (fresh.hash !== pending.inputHash) {
      await this.prisma.routePlan.updateMany({ where: { id: pending.id, stops: { none: {} } }, data: { optimizerResponse: jsonValue(result) } });
      throw new TripConflictError('OPTIMIZER_RESULT_STALE');
    }
    assertPermutation(result.stops.map((stop) => stop.trip_stop_id), fresh.input.stops.map((stop) => stop.stopId));
    if (!new Prisma.Decimal(String(result.vehicle_capacity_weight_kg)).eq(fresh.input.vehicle.capacityWeight) ||
      !new Prisma.Decimal(String(result.vehicle_capacity_volume_m3)).eq(fresh.input.vehicle.capacityVolume) ||
      !new Prisma.Decimal(String(result.total_demand_weight_kg)).eq(fresh.trip.totalWeight) ||
      !new Prisma.Decimal(String(result.total_demand_volume_m3)).eq(fresh.trip.totalVolume) ||
      result.stops.some((stop) => {
        const original = fresh.input.stops.find((item) => item.stopId === stop.trip_stop_id);
        return !original || !new Prisma.Decimal(String(stop.demand_weight_kg)).eq(original.demandWeight) ||
          !new Prisma.Decimal(String(stop.demand_volume_m3)).eq(original.demandVolume) ||
          !new Prisma.Decimal(String(stop.lat)).eq(original.addressSnapshot.latitude) ||
          !new Prisma.Decimal(String(stop.lng)).eq(original.addressSnapshot.longitude);
      })) throw new BusinessRuleViolationError('OPTIMIZER_RESPONSE_INPUT_MISMATCH');
    if (result.stops.some((stop, index) => stop.sequence !== index + 1))
      throw new BusinessRuleViolationError('OPTIMIZER_SEQUENCE_INVALID');
    const pendingId = pending.id;
    return this.prisma.$transaction(async (tx) => {
      await routeTrip(tx, user.tenantId, tripId, dto.expectedTripVersion);
      const current = await tx.routePlan.findFirstOrThrow({ where: { id: pendingId, tenantId: user.tenantId }, include: { stops: true } });
      if (current.stops.length) return planView(current);
      const plan = await tx.routePlan.update({
        where: { id: pendingId },
        data: {
          optimizationRunId: result.route_plan_id, optimizerResponse: jsonValue(result),
          solverName: result.solver_method, solverVersion: result.solver_version, objective: result.objective,
          totalDistance: new Prisma.Decimal(String(result.total_distance_km)).times(1000),
          metrics: jsonValue(result),
          stops: { create: result.stops.map((stop) => ({
            tenantId: user.tenantId, tripStopId: stop.trip_stop_id, sequence: stop.sequence,
            distanceFromPrevious: new Prisma.Decimal(String(stop.distance_from_prev_km)).times(1000),
            legDurationSeconds: stop.estimated_duration_minutes * 60,
          })) },
        }, include: { stops: true },
      });
      return planView(plan);
    });
  }

  private async replay(user: AuthenticatedUser, tripId: string, requestId: string, hash: string, tx: Prisma.TransactionClient = this.prisma) {
    const plan = await tx.routePlan.findFirst({ where: { tenantId: user.tenantId, routeRequestId: requestId }, include: { stops: true } });
    if (plan && (plan.tripId !== tripId || plan.requestActorId !== user.id || plan.requestHash !== hash))
      throw new TripConflictError('ROUTE_REQUEST_REPLAY_CONFLICT');
    return plan;
  }
  private async requireTrip(tenantId: string, tripId: string) {
    const trip = await this.prisma.deliveryTrip.findFirst({ where: { id: tripId, tenantId, deletedAt: null }, select: { id: true } });
    if (!trip) throw new EntityNotFoundError('DeliveryTrip', tripId);
  }
}
