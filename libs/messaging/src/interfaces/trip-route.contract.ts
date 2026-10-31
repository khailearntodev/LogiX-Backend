import { z } from 'zod';
import { sha256Schema, transportUuidSchema as uuid, transportVersionSchema as version } from './transport.contract.js';

const orderedStopIds = z.array(uuid).min(1).max(100).refine((ids) => new Set(ids).size === ids.length);
const reason = z.string().trim().min(1).max(1000);
const routeSelection = {
  expectedVersion: version,
  planId: uuid,
  planVersion: version,
  inputHash: sha256Schema,
};
export const manualTripRouteSchema = z.object({
  requestId: uuid,
  expectedTripVersion: version,
  orderedStopIds,
}).strict();
export const optimizeTripRouteSchema = z.object({
  requestId: uuid,
  expectedTripVersion: version,
}).strict();
export const tripRoutePreviewSchema = z.object({
  ...routeSelection,
  orderedStopIds: orderedStopIds.optional(),
  reason: reason.optional(),
}).strict().refine((value) => (value.orderedStopIds === undefined) === (value.reason === undefined));
export const approveTripRouteSchema = z.object({
  ...routeSelection,
  requestId: uuid,
  previewToken: z.string().min(1).max(4096),
  confirmed: z.literal(true),
}).strict();
export const overrideTripRouteSchema = approveTripRouteSchema.extend({ orderedStopIds, reason });
export const reopenTripSchema = z.object({ requestId: uuid, expectedVersion: version, reason }).strict();

const nullableObject = z.record(z.string(), z.unknown()).nullable();
export const tripRoutePlanViewSchema = z.object({
  id: uuid,
  tenantId: uuid,
  tripId: uuid,
  planVersion: version,
  version,
  routeRequestId: uuid,
  source: z.enum(['MANUAL', 'OPTIMIZED', 'OVERRIDE']),
  inputHash: sha256Schema,
  inputSnapshot: z.record(z.string(), z.unknown()),
  optimizationRunId: uuid.nullable(),
  solverName: z.string().nullable(),
  solverVersion: z.string().nullable(),
  objective: z.string().nullable(),
  // Decimal metres, not the optimizer provider's kilometre-valued metrics.
  totalDistance: z.string().nullable(),
  estimatedCost: z.string().nullable(),
  metrics: nullableObject,
  originalPlanId: uuid.nullable(),
  overrideReason: z.string().nullable(),
  approvedBy: uuid.nullable(),
  approvedAt: z.string().datetime({ offset: true }).nullable(),
  vehicleSnapshot: nullableObject,
  driverSnapshot: nullableObject,
  createdAt: z.string().datetime({ offset: true }),
  stops: z.array(z.object({
    tripStopId: uuid,
    sequence: version,
    eta: z.string().datetime({ offset: true }).nullable(),
    legDistance: z.string().nullable(), // Decimal metres.
    legDurationSeconds: z.number().int().nonnegative().safe().nullable(),
  }).strict()),
}).strict();
export const tripRoutePreviewViewSchema = z.object({
  previewToken: z.string(),
  expiresAt: z.string().datetime({ offset: true }),
  tripId: uuid,
  ...routeSelection,
  action: z.enum(['APPROVE', 'OVERRIDE']),
  orderedStopIds,
  reason: z.string().nullable(),
  vehicleSnapshot: z.record(z.string(), z.unknown()),
  driverSnapshot: z.record(z.string(), z.unknown()),
  totalWeight: z.string(),
  totalVolume: z.string(),
}).strict();

export type ManualTripRoute = z.infer<typeof manualTripRouteSchema>;
export type OptimizeTripRoute = z.infer<typeof optimizeTripRouteSchema>;
export type TripRoutePreview = z.infer<typeof tripRoutePreviewSchema>;
export type ApproveTripRoute = z.infer<typeof approveTripRouteSchema>;
export type OverrideTripRoute = z.infer<typeof overrideTripRouteSchema>;
export type ReopenTrip = z.infer<typeof reopenTripSchema>;

export const routeApprovedPayloadV2Schema = z.object({
  contractVersion: z.literal(1),
  actorId: uuid, tenantId: uuid, tripId: uuid, requestId: uuid,
  routePlanId: uuid, originalPlanId: uuid,
  source: z.enum(['MANUAL', 'OPTIMIZED', 'OVERRIDE']),
  planVersion: version, inputHash: sha256Schema,
  action: z.enum(['APPROVE', 'OVERRIDE']), reason: z.string().nullable(),
  approvedAt: z.string().datetime({ offset: true }),
  vehicleId: uuid, driverId: uuid,
  before: z.object({ status: z.literal('DRAFT'), version }).strict(),
  after: z.object({ status: z.literal('APPROVED'), version }).strict(),
}).strict();
export type RouteApprovedPayloadV2 = z.infer<typeof routeApprovedPayloadV2Schema>;
