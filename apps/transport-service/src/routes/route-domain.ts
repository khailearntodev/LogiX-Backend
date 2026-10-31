import { BusinessRuleViolationError, ConcurrencyConflictError, EntityNotFoundError, InvalidStateTransitionError } from '@logix/errors';
import { hashTransportContractPayload } from '@logix/messaging';
import { Prisma } from '../generated/prisma/client.js';
import { TripConflictError } from '../trips/trip-conflict.error.js';
import { toSafeVersion } from '../trips/trip-serialization.js';

export async function lockTrip(tx: Prisma.TransactionClient, tenantId: string, tripId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM transport.delivery_trips WHERE id = ${tripId}::uuid AND tenant_id = ${tenantId}::uuid FOR UPDATE`;
}

export async function routeTrip(tx: Prisma.TransactionClient, tenantId: string, tripId: string, expectedVersion: number, status = 'DRAFT') {
  await lockTrip(tx, tenantId, tripId);
  const trip = await tx.deliveryTrip.findFirst({
    where: { id: tripId, tenantId, deletedAt: null },
    include: {
      shipments: { where: { removedAt: null, deletedAt: null }, orderBy: { id: 'asc' } },
      stops: { where: { deletedAt: null }, orderBy: [{ plannedSequence: 'asc' }, { id: 'asc' }] },
    },
  });
  if (!trip) throw new EntityNotFoundError('DeliveryTrip', tripId);
  if (trip.version !== BigInt(expectedVersion) || trip.version >= BigInt(Number.MAX_SAFE_INTEGER))
    throw new ConcurrencyConflictError('DeliveryTrip', tripId, expectedVersion, toSafeVersion(trip.version));
  if (trip.status !== status) throw new InvalidStateTransitionError('DeliveryTrip', trip.status, 'ROUTE');
  await assertNoPending(tx, tenantId, tripId);
  return trip;
}

export async function assertNoPending(tx: Prisma.TransactionClient, tenantId: string, tripId: string) {
  const [operation, dispatch] = await Promise.all([
    tx.tripOperation.findFirst({ where: { activeLock: `${tenantId}:${tripId}` }, select: { id: true } }),
    tx.tripDispatch.findFirst({ where: { tenantId, tripId, status: { not: 'REJECTED' } }, select: { id: true } }),
  ]);
  if (operation || dispatch) throw new TripConflictError('TRIP_OPERATION_PENDING');
}

export function assertPermutation(ordered: string[], stopIds: string[]) {
  const set = new Set(ordered);
  if (!stopIds.length || set.size !== ordered.length || set.size !== stopIds.length || stopIds.some((id) => !set.has(id)))
    throw new BusinessRuleViolationError('ROUTE_REQUIRES_FULL_STOP_PERMUTATION');
}

export function decimal(value: unknown, scale: number, positive = false): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value))
    throw new BusinessRuleViolationError('ROUTE_MEASURE_INVALID');
  const number = new Prisma.Decimal(value);
  if (!number.isFinite() || number.isNegative() || (positive && number.isZero()) || number.decimalPlaces() > scale ||
    number.gte(new Prisma.Decimal(10).pow(18 - scale)))
    throw new BusinessRuleViolationError('ROUTE_MEASURE_INVALID');
  return number.toFixed(scale);
}

export function coordinate(value: unknown, bound: number): string {
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value))
    throw new BusinessRuleViolationError('ROUTE_COORDINATE_INVALID');
  const number = new Prisma.Decimal(value);
  if (!number.isFinite() || number.abs().gt(bound) || number.decimalPlaces() > 6)
    throw new BusinessRuleViolationError('ROUTE_COORDINATE_INVALID');
  return number.toFixed(6);
}

export function jsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export function routeHash(value: unknown): string {
  // All measures and coordinates are normalized decimal strings before this boundary.
  return hashTransportContractPayload(JSON.parse(JSON.stringify(value)));
}

export function mapResourceConflict(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
    throw new TripConflictError('TRIP_RESOURCE_OR_REQUEST_CONFLICT');
  throw error;
}
