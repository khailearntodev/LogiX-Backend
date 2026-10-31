import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { signInternalServiceToken } from '@logix/auth';
import { z } from 'zod';
import { BusinessRuleViolationError } from '@logix/errors';
import { DownstreamServiceError } from '../integrations/downstream-error.js';
import type { CurrentRouteInput } from './route-input.service.js';
import { Prisma } from '../generated/prisma/client.js';

const measure = z.number().finite().nonnegative();
export const optimizerResponseSchema = z.object({
  contract_version: z.literal(1), tenant_id: z.string().uuid(), trip_id: z.string().uuid(),
  route_request_id: z.string().uuid(), trip_version: z.number().int().positive().safe(),
  input_hash: z.string().regex(/^[a-f0-9]{64}$/), route_plan_id: z.string().uuid(),
  persisted: z.literal(true), completed_at: z.string().datetime({ offset: true }),
  solver_method: z.string().min(1), solver_version: z.string().min(1),
  config_version: z.string().min(1), objective: z.string().min(1),
  distance_provider: z.string().min(1), provider_version: z.string().nullable(),
  feasibility_status: z.literal('FEASIBLE'),
  total_distance_km: measure, total_duration_minutes: measure,
  vehicle_capacity_weight_kg: measure, vehicle_capacity_volume_m3: measure,
  total_demand_weight_kg: measure, total_demand_volume_m3: measure,
  baseline_input_order_km: measure, baseline_nearest_neighbor_km: measure,
  polyline: z.array(z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)])),
  legs: z.array(z.record(z.string(), z.unknown())),
  stops: z.array(z.object({
    trip_stop_id: z.string().uuid(), sequence: z.number().int().positive().safe(),
    distance_from_prev_km: measure, estimated_duration_minutes: z.number().int().nonnegative().safe(),
    lat: z.number().finite().min(-90).max(90), lng: z.number().finite().min(-180).max(180),
    demand_weight_kg: measure, demand_volume_m3: measure,
  }).passthrough()).min(1),
}).passthrough();
export type OptimizerResponse = z.infer<typeof optimizerResponseSchema>;

function solverNumber(value: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || !new Prisma.Decimal(String(number)).eq(value))
    throw new BusinessRuleViolationError('OPTIMIZER_NUMERIC_PRECISION_UNSUPPORTED');
  return number;
}

export function optimizerRequest(input: CurrentRouteInput['input'], requestId: string, hash: string) {
  return {
    contract_version: 1, tenant_id: input.tenantId, trip_id: input.tripId,
    warehouse_id: input.warehouseId, vehicle_id: input.vehicle.vehicleId,
    route_request_id: requestId, idempotency_key: requestId,
    trip_version: input.tripVersion, input_hash: hash, input_snapshot: input,
    depot: { name: input.depot.name, address: input.depot.address, lat: solverNumber(input.depot.latitude), lng: solverNumber(input.depot.longitude) },
    vehicle: {
      vehicle_id: input.vehicle.vehicleId, plate_number: input.vehicle.plateNumber,
      capacity_weight_kg: solverNumber(input.vehicle.capacityWeight),
      capacity_volume_m3: solverNumber(input.vehicle.capacityVolume),
    },
    stops: input.stops.map((stop) => ({
      trip_stop_id: stop.stopId, stop_name: stop.shipmentId, address: stop.addressSnapshot.addressLine,
      lat: solverNumber(stop.addressSnapshot.latitude), lng: solverNumber(stop.addressSnapshot.longitude),
      demand_weight_kg: solverNumber(stop.demandWeight), demand_volume_m3: solverNumber(stop.demandVolume), sequence: stop.sequence,
    })),
  };
}

@Injectable()
export class OptimizerClient {
  constructor(private readonly config: ConfigService) {}
  async compute(tenantId: string, input: unknown): Promise<OptimizerResponse> {
    const token = signInternalServiceToken({
      service: 'transport-service', audience: 'route-optimizer-service', tenantId,
      secret: this.config.getOrThrow<string>('INTERNAL_SERVICE_JWT_SECRET'), ttlSeconds: 60,
    });
    let response: Response;
    try {
      response = await fetch(new URL('/api/v1/route-optimizations', this.config.getOrThrow<string>('ROUTE_OPTIMIZER_SERVICE_URL')), {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-service-token': token },
        body: JSON.stringify(input), signal: AbortSignal.timeout(this.config.getOrThrow<number>('ROUTE_OPTIMIZER_TIMEOUT_MS')),
      });
    } catch {
      throw new DownstreamServiceError('Route Optimizer', null);
    }
    if (!response.ok) {
      if (response.status === 409) throw new BusinessRuleViolationError('OPTIMIZER_REQUEST_CONFLICT');
      throw new DownstreamServiceError('Route Optimizer', response.status);
    }
    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      throw new BusinessRuleViolationError('OPTIMIZER_RESPONSE_INVALID_OR_INFEASIBLE');
    }
    const result = optimizerResponseSchema.safeParse(raw);
    if (!result.success) throw new BusinessRuleViolationError('OPTIMIZER_RESPONSE_INVALID_OR_INFEASIBLE');
    return result.data;
  }
}
