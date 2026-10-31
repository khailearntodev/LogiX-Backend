import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  BusinessRuleViolationError,
  ConcurrencyConflictError,
  EntityNotFoundError,
  InvalidStateTransitionError,
} from '@logix/errors';
import type { AuthenticatedUser } from '@logix/auth';
import {
  TRANSPORT_CONTRACT_VERSION,
  type ShipmentClaimRequest,
  type ShipmentReleaseRequest,
} from '@logix/messaging';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../database/prisma.service.js';
import { DownstreamError } from '../integrations/downstream-error.js';
import {
  FulfillmentClient,
  InvalidClaimSnapshotError,
} from '../integrations/fulfillment.client.js';
import type { AddShipmentsDto, RemoveShipmentsDto } from './trip.dto.js';
import { stableHash, toSafeVersion } from './trip-serialization.js';
import { TripQueryService } from './trip-query.service.js';
import { TripConflictError } from './trip-conflict.error.js';
import { lockTrip } from '../routes/route-domain.js';

const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 60_000;
const PROCESS_LEASE_MS = 30_000;

export interface TripOperationView {
  tripId: string | null;
  requestId: string;
  kind: string;
  status: 'PENDING' | 'COMPLETED' | 'REJECTED';
  version: number;
  results: Array<{ shipmentId: string; state: string; reason?: string }>;
}

@Injectable()
export class TripMembershipService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fulfillment: FulfillmentClient,
    private readonly queries: TripQueryService,
  ) {}

  async add(user: AuthenticatedUser, tripId: string, dto: AddShipmentsDto) {
    const hash = stableHash({ kind: 'ADD', tripId, ...dto });
    const replay = await this.replay(
      user.tenantId,
      dto.requestId,
      user.id,
      hash,
    );
    if (replay) {
      await this.resume(replay.id, true);
      return this.operationView(user.tenantId, dto.requestId);
    }
    const operationId = randomUUID();
    try {
      await this.prisma.$transaction(async (tx) => {
        await lockTrip(tx, user.tenantId, tripId);
        const trip = await tx.deliveryTrip.findFirst({
          where: { id: tripId, tenantId: user.tenantId, deletedAt: null },
        });
        if (!trip) throw new EntityNotFoundError('DeliveryTrip', tripId);
        this.assertVersion(tripId, dto.expectedTripVersion, trip.version);
        if (trip.status !== 'DRAFT') {
          throw new InvalidStateTransitionError(
            'DeliveryTrip',
            trip.status,
            'ADD_SHIPMENTS',
          );
        }
        if (trip.version >= BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new ConcurrencyConflictError(
            'DeliveryTrip',
            tripId,
            dto.expectedTripVersion,
            toSafeVersion(trip.version),
          );
        }
        const conflict = await tx.tripOperation.findFirst({
          where: { activeLock: `${user.tenantId}:${tripId}` },
          select: { requestId: true },
        });
        if (conflict) {
          throw new TripConflictError('TRIP_OPERATION_PENDING', {
            requestId: conflict.requestId,
          });
        }
        const existing = await tx.tripShipment.findMany({
          where: {
            tenantId: user.tenantId,
            tripId,
            shipmentId: {
              in: dto.shipments.map(({ shipmentId }) => shipmentId),
            },
            removedAt: null,
          },
          select: { shipmentId: true },
        });
        if (existing.length > 0) {
          throw new BusinessRuleViolationError('SHIPMENT_ALREADY_IN_TRIP', {
            shipmentIds: existing.map(({ shipmentId }) => shipmentId),
          });
        }
        const tripVersion = toSafeVersion(trip.version + 1n);
        const membershipIds = dto.shipments.map(() => randomUUID());
        await tx.tripOperation.create({
          data: {
            id: operationId,
            tenantId: user.tenantId,
            tripId,
            requestId: dto.requestId,
            actorId: user.id,
            kind: 'ADD',
            status: 'PENDING',
            payloadHash: hash,
            payload: {
              request: dto,
              shipmentIds: dto.shipments.map(({ shipmentId }) => shipmentId),
              membershipIds,
              reason: null,
            },
            activeLock: `${user.tenantId}:${tripId}`,
          },
        });
        await tx.tripShipment.createMany({
          data: dto.shipments.map((item, index) => ({
            id: membershipIds[index],
            tenantId: user.tenantId,
            tripId,
            operationId,
            shipmentId: item.shipmentId,
            warehouseId: trip.warehouseId,
            state: 'CLAIM_PENDING',
            expectedShipmentVersion: BigInt(item.expectedShipmentVersion),
            weight: new Prisma.Decimal(0),
            volume: new Prisma.Decimal(0),
            claimRequest: {
              contractVersion: TRANSPORT_CONTRACT_VERSION,
              tenantId: user.tenantId,
              requestId: randomUUID(),
              tripId,
              shipmentId: item.shipmentId,
              actorId: user.id,
              expectedTripVersion: tripVersion,
              expectedShipmentVersion: item.expectedShipmentVersion,
            } satisfies ShipmentClaimRequest as Prisma.InputJsonValue,
          })),
        });
        await tx.deliveryTrip.update({
          where: { id: tripId },
          data: { version: { increment: 1 } },
        });
      });
    } catch (error) {
      const raced = await this.replay(
        user.tenantId,
        dto.requestId,
        user.id,
        hash,
      );
      if (raced) {
        await this.resume(raced.id, true);
        return this.operationView(user.tenantId, dto.requestId);
      }
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new TripConflictError('SHIPMENT_OR_TRIP_OPERATION_CONFLICT', {
          shipmentIds: dto.shipments.map(({ shipmentId }) => shipmentId),
        });
      }
      throw error;
    }
    await this.resume(operationId, true);
    return this.operationView(user.tenantId, dto.requestId);
  }

  async remove(
    user: AuthenticatedUser,
    tripId: string,
    dto: RemoveShipmentsDto,
  ) {
    const hash = stableHash({ kind: 'REMOVE', tripId, ...dto });
    const replay = await this.replay(
      user.tenantId,
      dto.requestId,
      user.id,
      hash,
    );
    if (replay) {
      await this.resume(replay.id, true);
      return this.operationView(user.tenantId, dto.requestId);
    }
    const operationId = randomUUID();
    await this.prisma.$transaction(async (tx) => {
      await lockTrip(tx, user.tenantId, tripId);
      const trip = await tx.deliveryTrip.findFirst({
        where: { id: tripId, tenantId: user.tenantId, deletedAt: null },
      });
      if (!trip) throw new EntityNotFoundError('DeliveryTrip', tripId);
      this.assertVersion(tripId, dto.expectedTripVersion, trip.version);
      if (trip.status !== 'DRAFT') {
        throw new InvalidStateTransitionError(
          'DeliveryTrip',
          trip.status,
          'REMOVE_SHIPMENTS',
        );
      }
      if (trip.version >= BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new ConcurrencyConflictError(
          'DeliveryTrip',
          tripId,
          dto.expectedTripVersion,
          toSafeVersion(trip.version),
        );
      }
      const conflict = await tx.tripOperation.findFirst({
        where: { activeLock: `${user.tenantId}:${tripId}` },
        select: { requestId: true },
      });
      if (conflict) {
        throw new TripConflictError('TRIP_OPERATION_PENDING', {
          requestId: conflict.requestId,
        });
      }
      const memberships = await tx.tripShipment.findMany({
        where: {
          tenantId: user.tenantId,
          tripId,
          shipmentId: { in: dto.shipmentIds },
          state: 'ACTIVE',
          removedAt: null,
        },
      });
      if (memberships.length !== dto.shipmentIds.length) {
        throw new BusinessRuleViolationError('SHIPMENT_NOT_ACTIVE_ON_TRIP', {
          shipmentIds: dto.shipmentIds.filter(
            (id) =>
              !memberships.some((membership) => membership.shipmentId === id),
          ),
        });
      }
      const membershipIds = memberships.map((membership) => membership.id);
      await tx.tripOperation.create({
        data: {
          id: operationId,
          tenantId: user.tenantId,
          tripId,
          requestId: dto.requestId,
          actorId: user.id,
          kind: 'REMOVE',
          status: 'PENDING',
          payloadHash: hash,
          payload: {
            request: dto,
            shipmentIds: dto.shipmentIds,
            membershipIds,
            reason: 'REMOVED_FROM_TRIP',
          },
          activeLock: `${user.tenantId}:${tripId}`,
        },
      });
      for (const membership of memberships) {
        const request = this.releaseRequest(
          membership,
          user.id,
          toSafeVersion(trip.version + 1n),
          'REMOVED_FROM_TRIP',
        );
        await tx.tripShipment.update({
          where: { id: membership.id },
          data: {
            operationId,
            state: 'RELEASE_PENDING',
            releaseRequest: request,
          },
        });
      }
      await tx.deliveryTrip.update({
        where: { id: tripId },
        data: { version: { increment: 1 } },
      });
    });
    await this.resume(operationId, true);
    return this.operationView(user.tenantId, dto.requestId);
  }

  async resume(operationId: string, force = false): Promise<void> {
    const now = new Date();
    const lock = await this.prisma.tripOperation.updateMany({
      where: {
        id: operationId,
        status: { in: ['PENDING', 'COMPENSATING'] },
        ...(force ? {} : { nextAttemptAt: { lte: now } }),
        OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
      },
      data: { lockedUntil: new Date(now.getTime() + PROCESS_LEASE_MS) },
    });
    if (lock.count !== 1) return;
    try {
      await this.process(operationId);
    } catch (error) {
      const operation = await this.prisma.tripOperation.findUnique({
        where: { id: operationId },
      });
      if (!operation || !['PENDING', 'COMPENSATING'].includes(operation.status))
        return;
      await this.scheduleRetry(operationId, error);
    } finally {
      await this.prisma.tripOperation.updateMany({
        where: { id: operationId },
        data: { lockedUntil: null },
      });
    }
  }

  async operationView(
    tenantId: string,
    requestId: string,
  ): Promise<TripOperationView | null> {
    const operation = await this.prisma.tripOperation.findFirst({
      where: { tenantId, requestId },
    });
    if (!operation) return null;
    return this.serializeOperation(operation);
  }

  async resumeByRequest(
    tenantId: string,
    requestId: string,
    force = false,
  ): Promise<void> {
    const operation = await this.prisma.tripOperation.findUnique({
      where: { tenantId_requestId: { tenantId, requestId } },
      select: { id: true },
    });
    if (operation) await this.resume(operation.id, force);
  }

  private async process(operationId: string): Promise<void> {
    let operation = await this.prisma.tripOperation.findUnique({
      where: { id: operationId },
    });
    if (!operation || !['PENDING', 'COMPENSATING'].includes(operation.status))
      return;
    if (operation.status === 'PENDING' && operation.kind === 'ADD') {
      const rows = await this.prisma.tripShipment.findMany({
        where: { operationId, state: 'CLAIM_PENDING' },
        orderBy: [{ assignedAt: 'asc' }, { id: 'asc' }],
      });
      for (const membership of rows) {
        const request =
          membership.claimRequest as unknown as ShipmentClaimRequest;
        try {
          const result = await this.fulfillment.claim(request);
          try {
            await this.persistClaim(membership.id, result);
          } catch (error) {
            if (error instanceof InvalidClaimSnapshotError) {
              await this.beginCompensation(operationId, error.message, {
                membershipId: membership.id,
                receipt: error.receipt,
              });
            }
            if (error instanceof DownstreamError && error.definite) {
              await this.beginCompensation(operationId, error.message, {
                membershipId: membership.id,
                receipt: result.receipt,
              });
            }
            throw error;
          }
        } catch (error) {
          if (error instanceof DownstreamError && error.definite) {
            await this.beginCompensation(operationId, error.message);
            operation = await this.prisma.tripOperation.findUniqueOrThrow({
              where: { id: operationId },
            });
            break;
          }
          throw error;
        }
      }
      operation = await this.prisma.tripOperation.findUniqueOrThrow({
        where: { id: operationId },
      });
      if (operation.status === 'PENDING') {
        const pending = await this.prisma.tripShipment.count({
          where: { operationId, state: 'CLAIM_PENDING' },
        });
        if (pending === 0) await this.finalize(operationId, 'COMPLETED');
        return;
      }
    }
    operation = await this.prisma.tripOperation.findUniqueOrThrow({
      where: { id: operationId },
    });
    if (
      operation.status === 'COMPENSATING' ||
      operation.kind === 'REMOVE' ||
      operation.kind === 'CANCEL' ||
      operation.kind === 'SHIPMENT_CANCELED'
    ) {
      const releases = await this.prisma.tripShipment.findMany({
        where: { operationId, state: 'RELEASE_PENDING' },
        orderBy: [{ assignedAt: 'asc' }, { id: 'asc' }],
      });
      for (const membership of releases) {
        const request =
          membership.releaseRequest as unknown as ShipmentReleaseRequest;
        const result = await this.fulfillment.release(request);
        await this.persistRelease(membership.id, result);
      }
      const pending = await this.prisma.tripShipment.count({
        where: { operationId, state: 'RELEASE_PENDING' },
      });
      if (pending > 0) return;
      if (operation.status === 'COMPENSATING') {
        await this.finalize(operationId, 'REJECTED');
      } else {
        await this.finalize(operationId, 'COMPLETED');
      }
    }
  }

  private async persistClaim(
    membershipId: string,
    result: Awaited<ReturnType<FulfillmentClient['claim']>>,
  ) {
    const snapshot = result.snapshot;
    const claimedMembership = await this.prisma.tripShipment.findUniqueOrThrow({
      where: { id: membershipId },
      select: {
        tenantId: true,
        tripId: true,
        warehouseId: true,
        shipmentId: true,
      },
    });
    if (
      snapshot.tenantId !== claimedMembership.tenantId ||
      snapshot.warehouseId !== claimedMembership.warehouseId ||
      snapshot.shipmentId !== claimedMembership.shipmentId
    ) {
      throw new DownstreamError(
        'Fulfillment claim snapshot does not match the stored intent',
        502,
        true,
      );
    }
    const delivery = snapshot.deliveryAddressSnapshot;
    const addressId =
      typeof delivery.addressId === 'string' ? delivery.addressId : null;
    if (!addressId) {
      throw new DownstreamError(
        'Fulfillment claim has no immutable delivery address id',
        502,
        true,
      );
    }
    const weight = new Prisma.Decimal(snapshot.totalWeight);
    const volume = new Prisma.Decimal(snapshot.totalVolume);
    const latitude = this.coordinate(delivery.latitude, -90, 90);
    const longitude = this.coordinate(delivery.longitude, -180, 180);
    if (latitude === null || longitude === null) {
      throw new DownstreamError(
        'Fulfillment returned missing address coordinates',
        502,
        true,
      );
    }
    await this.prisma.$transaction(async (tx) => {
      const membership = await tx.tripShipment.findUniqueOrThrow({
        where: { id: membershipId },
      });
      if (membership.state !== 'CLAIM_PENDING') return;
      const stop = await tx.tripStop.findUnique({
        where: {
          tenantId_tripId_shipmentId: {
            tenantId: membership.tenantId,
            tripId: membership.tripId,
            shipmentId: membership.shipmentId,
          },
        },
      });
      const plannedSequence =
        (await tx.tripStop.count({
          where: {
            tenantId: membership.tenantId,
            tripId: membership.tripId,
            deletedAt: null,
          },
        })) + 1;
      const stopData = {
        deliveryAddressId: addressId,
        addressSnapshot: delivery as Prisma.InputJsonValue,
        latitude,
        longitude,
        plannedSequence,
        status: 'PENDING',
        deletedAt: null,
      };
      if (stop) {
        await tx.tripStop.update({
          where: { id: stop.id },
          data: { ...stopData, version: { increment: 1 } },
        });
      } else {
        await tx.tripStop.create({
          data: {
            tenantId: membership.tenantId,
            tripId: membership.tripId,
            shipmentId: membership.shipmentId,
            currentAttempt: 0,
            ...stopData,
          },
        });
      }
      await tx.tripShipment.update({
        where: { id: membershipId },
        data: {
          state: 'ACTIVE',
          orderId: snapshot.orderId,
          shipmentVersion: BigInt(snapshot.shipmentVersion),
          orderVersion: BigInt(snapshot.orderVersion),
          weight,
          volume,
          claimReceipt: result.receipt as unknown as Prisma.InputJsonValue,
          shipmentSnapshot: snapshot as unknown as Prisma.InputJsonValue,
        },
      });
      await this.recalculateTripTotals(
        tx,
        membership.tenantId,
        membership.tripId,
      );
    });
  }

  private coordinate(
    value: unknown,
    minimum: number,
    maximum: number,
  ): Prisma.Decimal | null {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string' || !/^-?\d{1,3}(?:\.\d{1,6})?$/.test(value)) {
      throw new DownstreamError(
        'Fulfillment returned an invalid coordinate',
        502,
        true,
      );
    }
    const number = Number(value);
    if (!Number.isFinite(number) || number < minimum || number > maximum) {
      throw new DownstreamError(
        'Fulfillment returned an invalid coordinate',
        502,
        true,
      );
    }
    return new Prisma.Decimal(value);
  }

  private async beginCompensation(
    operationId: string,
    reason: string,
    invalidClaim?: {
      membershipId: string;
      receipt: Awaited<ReturnType<FulfillmentClient['claim']>>['receipt'];
    },
  ) {
    await this.prisma.$transaction(async (tx) => {
      const operation = await tx.tripOperation.findUniqueOrThrow({
        where: { id: operationId },
      });
      const trip = await tx.deliveryTrip.findUniqueOrThrow({
        where: { id: operation.tripId as string },
        select: { version: true },
      });
      if (invalidClaim) {
        await tx.tripShipment.update({
          where: { id: invalidClaim.membershipId },
          data: {
            state: 'ACTIVE',
            claimReceipt:
              invalidClaim.receipt as unknown as Prisma.InputJsonValue,
            shipmentVersion: BigInt(invalidClaim.receipt.shipmentVersion),
          },
        });
      }
      const memberships = await tx.tripShipment.findMany({
        where: { operationId },
      });
      for (const membership of memberships) {
        if (membership.state === 'ACTIVE') {
          const request = this.releaseRequest(
            membership,
            operation.actorId,
            toSafeVersion(trip.version),
            'BATCH_ADD_COMPENSATION',
          );
          await tx.tripShipment.update({
            where: { id: membership.id },
            data: { state: 'RELEASE_PENDING', releaseRequest: request },
          });
        } else if (membership.state === 'CLAIM_PENDING') {
          await tx.tripShipment.update({
            where: { id: membership.id },
            data: { state: 'RELEASED', removedAt: new Date() },
          });
        }
      }
      await tx.tripOperation.update({
        where: { id: operationId },
        data: { status: 'COMPENSATING', lastError: reason },
      });
    });
  }

  private releaseRequest(
    membership: {
      tenantId: string;
      tripId: string;
      shipmentId: string;
      shipmentVersion: bigint | null;
      claimReceipt: Prisma.JsonValue | null;
    },
    actorId: string,
    expectedTripVersion: number,
    reason: string,
  ): ShipmentReleaseRequest {
    const receipt = membership.claimReceipt as { claimId?: unknown } | null;
    if (
      !receipt ||
      typeof receipt.claimId !== 'string' ||
      membership.shipmentVersion === null
    ) {
      throw new Error(
        'Cannot prepare release without a durable Fulfillment claim receipt',
      );
    }
    return {
      contractVersion: TRANSPORT_CONTRACT_VERSION,
      tenantId: membership.tenantId,
      requestId: randomUUID(),
      claimId: receipt.claimId,
      tripId: membership.tripId,
      shipmentId: membership.shipmentId,
      actorId,
      expectedTripVersion,
      expectedShipmentVersion: toSafeVersion(membership.shipmentVersion),
      reason,
    };
  }

  private async persistRelease(
    membershipId: string,
    result: Awaited<ReturnType<FulfillmentClient['release']>>,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const membership = await tx.tripShipment.findUniqueOrThrow({
        where: { id: membershipId },
      });
      if (membership.state !== 'RELEASE_PENDING') return;
      await tx.tripShipment.update({
        where: { id: membershipId },
        data: {
          state: 'RELEASED',
          removedAt: new Date(),
          releaseReceipt: result.receipt as unknown as Prisma.InputJsonValue,
        },
      });
      await tx.tripStop.updateMany({
        where: {
          tenantId: membership.tenantId,
          tripId: membership.tripId,
          shipmentId: membership.shipmentId,
          deletedAt: null,
        },
        data: { deletedAt: new Date(), approvedSequence: null, version: { increment: 1 } },
      });
      await this.recalculateTripTotals(
        tx,
        membership.tenantId,
        membership.tripId,
      );
    });
  }

  private async recalculateTripTotals(
    tx: Prisma.TransactionClient,
    tenantId: string,
    tripId: string,
  ): Promise<void> {
    const rows = await tx.tripShipment.findMany({
      where: {
        tenantId,
        tripId,
        state: 'ACTIVE',
        removedAt: null,
      },
      select: { weight: true, volume: true },
    });
    await tx.deliveryTrip.update({
      where: { id: tripId },
      data: {
        totalWeight: rows.reduce(
          (sum, row) => sum.plus(row.weight),
          new Prisma.Decimal(0),
        ),
        totalVolume: rows.reduce(
          (sum, row) => sum.plus(row.volume),
          new Prisma.Decimal(0),
        ),
      },
    });
  }

  private async finalize(
    operationId: string,
    status: 'COMPLETED' | 'REJECTED',
  ) {
    await this.prisma.$transaction(async (tx) => {
      const operation = await tx.tripOperation.findUniqueOrThrow({
        where: { id: operationId },
      });
      if (!operation.tripId)
        throw new Error('Trip operation is missing trip identity');
      const rows = await tx.tripShipment.findMany({
        where: {
          tenantId: operation.tenantId,
          tripId: operation.tripId,
          removedAt: null,
          state: 'ACTIVE',
        },
      });
      const totalWeight = rows.reduce(
        (sum, row) => sum.plus(row.weight),
        new Prisma.Decimal(0),
      );
      const totalVolume = rows.reduce(
        (sum, row) => sum.plus(row.volume),
        new Prisma.Decimal(0),
      );
      const trip = await tx.deliveryTrip.findFirst({
        where: { id: operation.tripId, tenantId: operation.tenantId },
      });
      if (!trip)
        throw new EntityNotFoundError('DeliveryTrip', operation.tripId);
      const cancel = operation.kind === 'CANCEL' && status === 'COMPLETED';
      const updated = await tx.deliveryTrip.update({
        where: { id: trip.id },
        data: {
          totalWeight: cancel ? new Prisma.Decimal(0) : totalWeight,
          totalVolume: cancel ? new Prisma.Decimal(0) : totalVolume,
          version: { increment: 1 },
          ...(cancel
            ? {
                status: 'CANCELED',
                approvedRoutePlanId: null,
                canceledAt: new Date(),
                cancelReason: String(
                  (operation.payload as { reason?: unknown }).reason ?? '',
                ),
              }
            : {}),
        },
      });
      const memberships = await tx.tripShipment.findMany({
        where: { operationId },
        orderBy: [{ assignedAt: 'asc' }, { id: 'asc' }],
      });
      const result = {
        tripId: trip.id,
        requestId: operation.requestId,
        kind: operation.kind,
        status,
        version: toSafeVersion(updated.version),
        results: memberships.map((membership) => ({
          shipmentId: membership.shipmentId,
          state: membership.state,
          ...(status === 'REJECTED' && operation.lastError
            ? { reason: operation.lastError }
            : {}),
        })),
      };
      await tx.tripOperation.update({
        where: { id: operationId },
        data: {
          status,
          result,
          activeLock: null,
          lockedUntil: null,
          lastError: operation.lastError,
          version: { increment: 1 },
        },
      });
      if (cancel) {
        const eventId = randomUUID();
        await tx.outboxEvent.create({
          data: {
            id: eventId,
            tenantId: operation.tenantId,
            eventType: 'TripCanceled',
            eventVersion: 1,
            aggregateType: 'DeliveryTrip',
            aggregateId: trip.id,
            aggregateVersion: updated.version,
            correlationId: operation.requestId,
            causationId: operation.requestId,
            payload: {
              tenantId: operation.tenantId,
              actorId: operation.actorId,
              actorType: 'USER',
              action: 'transport.trip.cancel',
              entityType: 'DeliveryTrip',
              entityId: trip.id,
              outcome: 'SUCCESS',
              beforeData: {
                status: trip.status,
                version: toSafeVersion(trip.version),
              },
              afterData: {
                status: 'CANCELED',
                version: toSafeVersion(updated.version),
              },
              metadata: {
                requestId: operation.requestId,
                reason:
                  (operation.payload as { reason?: unknown }).reason ?? null,
              },
              correlationId: operation.requestId,
              causationId: operation.requestId,
              sourceService: 'transport-service',
              sourceEventId: eventId,
              occurredAt: (updated.canceledAt ?? new Date()).toISOString(),
            },
            occurredAt: updated.canceledAt ?? new Date(),
          },
        });
      }
    });
  }

  private async scheduleRetry(operationId: string, error: unknown) {
    const operation = await this.prisma.tripOperation.findUnique({
      where: { id: operationId },
      select: { attemptCount: true },
    });
    if (!operation) return;
    const attempts = operation.attemptCount + 1;
    const delay = Math.min(
      RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 10),
      RETRY_MAX_MS,
    );
    await this.prisma.tripOperation.update({
      where: { id: operationId },
      data: {
        attemptCount: attempts,
        nextAttemptAt: new Date(Date.now() + delay),
        lockedUntil: null,
        lastError:
          error instanceof Error
            ? error.message
            : 'Downstream operation failed',
      },
    });
  }

  private async serializeOperation(operation: {
    id: string;
    tenantId: string;
    tripId: string | null;
    requestId: string;
    kind: string;
    status: string;
    payload: Prisma.JsonValue;
    result: Prisma.JsonValue | null;
    lastError: string | null;
  }): Promise<TripOperationView> {
    if (operation.result)
      return operation.result as unknown as TripOperationView;
    const payload = operation.payload as {
      shipmentIds?: string[];
      membershipIds?: string[];
    };
    const rows = await this.prisma.tripShipment.findMany({
      where: {
        tenantId: operation.tenantId,
        ...(payload.membershipIds?.length
          ? { id: { in: payload.membershipIds } }
          : { operationId: operation.id }),
      },
      orderBy: [{ assignedAt: 'asc' }, { id: 'asc' }],
    });
    const trip = operation.tripId
      ? await this.prisma.deliveryTrip.findFirst({
          where: { id: operation.tripId, tenantId: operation.tenantId },
          select: { version: true },
        })
      : null;
    return {
      tripId: operation.tripId,
      requestId: operation.requestId,
      kind: operation.kind,
      status:
        operation.status === 'COMPENSATING'
          ? 'PENDING'
          : operation.status === 'COMPLETED'
            ? 'COMPLETED'
            : operation.status === 'REJECTED'
              ? 'REJECTED'
              : 'PENDING',
      version: trip ? toSafeVersion(trip.version) : 1,
      results: rows.map((membership) => ({
        shipmentId: membership.shipmentId,
        state: membership.state,
        ...(operation.lastError ? { reason: operation.lastError } : {}),
      })),
    };
  }

  private async replay(
    tenantId: string,
    requestId: string,
    actorId: string,
    payloadHash: string,
  ) {
    const operation = await this.prisma.tripOperation.findUnique({
      where: { tenantId_requestId: { tenantId, requestId } },
    });
    if (!operation) return null;
    if (
      operation.actorId !== actorId ||
      operation.payloadHash !== payloadHash
    ) {
      throw new TripConflictError('REQUEST_ID_REPLAY_MISMATCH', { requestId });
    }
    return operation;
  }

  private assertVersion(tripId: string, expected: number, actual: bigint) {
    if (actual !== BigInt(expected)) {
      throw new ConcurrencyConflictError(
        'DeliveryTrip',
        tripId,
        expected,
        toSafeVersion(actual),
      );
    }
  }
}
