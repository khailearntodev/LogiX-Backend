import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  BusinessRuleViolationError,
  ConcurrencyConflictError,
  EntityNotFoundError,
  InvalidStateTransitionError,
} from '@logix/errors';
import type { AuthenticatedUser } from '@logix/auth';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../database/prisma.service.js';
import { MasterDataClient } from '../integrations/master-data.client.js';
import type {
  AssignmentDto,
  CreateTripDto,
  UpdateTripDto,
} from './trip.dto.js';
import { TripQueryService } from './trip-query.service.js';
import { stableHash, toSafeVersion } from './trip-serialization.js';
import { TripConflictError } from './trip-conflict.error.js';

@Injectable()
export class TripCommandService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly masterData: MasterDataClient,
    private readonly queries: TripQueryService,
  ) {}

  async create(
    user: AuthenticatedUser,
    dto: CreateTripDto,
    authorization: string,
  ) {
    const hash = stableHash({ kind: 'CREATE', ...dto });
    const replay = await this.replay(
      user.tenantId,
      dto.requestId,
      user.id,
      hash,
    );
    if (replay) {
      const tripId = (replay.result as { tripId: string }).tripId;
      return this.requireTrip(user.tenantId, tripId);
    }

    const depot = await this.masterData.warehouse(
      user.tenantId,
      dto.warehouseId,
      authorization,
    );
    const vehicle = dto.vehicleId
      ? await this.masterData.vehicle(dto.vehicleId, authorization)
      : null;
    const driver = dto.driverId
      ? await this.masterData.lockDriver(
          user.tenantId,
          dto.driverId,
          authorization,
        )
      : null;

    const tripId = randomUUID();
    const tripNumber = `TR-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${tripId.slice(0, 8).toUpperCase()}`;
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.deliveryTrip.create({
          data: {
            id: tripId,
            tenantId: user.tenantId,
            tripNumber,
            warehouseId: dto.warehouseId,
            depotSnapshot: depot as unknown as Prisma.InputJsonValue,
            vehicleId: vehicle?.id ?? null,
            driverId: driver?.driverId ?? null,
            driverUserId: driver?.userId ?? null,
            driverVersion: driver ? BigInt(driver.version) : null,
            status: 'DRAFT',
            plannedStartAt: new Date(dto.plannedStartAt),
            totalWeight: new Prisma.Decimal(0),
            totalVolume: new Prisma.Decimal(0),
            dispatchVersion: BigInt(0),
          },
        });
        await tx.tripOperation.create({
          data: {
            tenantId: user.tenantId,
            tripId,
            requestId: dto.requestId,
            actorId: user.id,
            kind: 'CREATE',
            status: 'COMPLETED',
            payloadHash: hash,
            payload: { kind: 'CREATE', ...dto },
            result: {
              tripId,
              requestId: dto.requestId,
              kind: 'CREATE',
              status: 'COMPLETED',
              version: 1,
              results: [],
            },
          },
        });
      });
    } catch (error) {
      const raced = await this.replay(
        user.tenantId,
        dto.requestId,
        user.id,
        hash,
      );
      if (raced)
        return this.requireTrip(
          user.tenantId,
          (raced.result as { tripId: string }).tripId,
        );
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new BusinessRuleViolationError(
          'TRIP_NUMBER_OR_REQUEST_ID_CONFLICT',
          {
            requestId: dto.requestId,
          },
        );
      }
      throw error;
    }
    return this.requireTrip(user.tenantId, tripId);
  }

  async update(
    user: AuthenticatedUser,
    tripId: string,
    dto: UpdateTripDto,
    authorization: string,
  ) {
    return this.updateFields(user, tripId, dto, authorization, 'UPDATE');
  }

  async assign(
    user: AuthenticatedUser,
    tripId: string,
    dto: AssignmentDto,
    authorization: string,
  ) {
    return this.updateFields(user, tripId, dto, authorization, 'ASSIGNMENT');
  }

  private async updateFields(
    user: AuthenticatedUser,
    tripId: string,
    dto: UpdateTripDto | AssignmentDto,
    authorization: string,
    kind: 'UPDATE' | 'ASSIGNMENT',
  ) {
    const hash = stableHash({ kind, tripId, ...dto });
    const replay = await this.replay(
      user.tenantId,
      dto.requestId,
      user.id,
      hash,
    );
    if (replay) return this.requireTrip(user.tenantId, tripId);
    if (dto.driverId === undefined || dto.driverId === null) {
      return this.updateLocalFields(user, tripId, dto, authorization, kind);
    }

    const current = await this.prisma.deliveryTrip.findFirst({
      where: { id: tripId, tenantId: user.tenantId, deletedAt: null },
    });
    if (!current) throw new EntityNotFoundError('DeliveryTrip', tripId);
    this.assertVersion(tripId, dto.expectedVersion, current.version);
    if (current.status !== 'DRAFT') {
      throw new InvalidStateTransitionError(
        'DeliveryTrip',
        current.status,
        kind,
      );
    }
    const pendingOperation = await this.prisma.tripOperation.findFirst({
      where: { activeLock: `${user.tenantId}:${tripId}` },
      select: { requestId: true },
    });
    if (pendingOperation) {
      throw new TripConflictError('TRIP_OPERATION_PENDING', {
        requestId: pendingOperation.requestId,
      });
    }
    if (current.version >= BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new ConcurrencyConflictError(
        'DeliveryTrip',
        tripId,
        dto.expectedVersion,
        toSafeVersion(current.version),
      );
    }

    const vehicleId =
      dto.vehicleId !== undefined ? dto.vehicleId : current.vehicleId;
    const driverId =
      dto.driverId !== undefined ? dto.driverId : current.driverId;
    if (vehicleId) await this.masterData.vehicle(vehicleId, authorization);
    const driver = driverId
      ? await this.masterData.lockDriver(user.tenantId, driverId, authorization)
      : null;

    const plannedStartAt =
      'plannedStartAt' in dto ? dto.plannedStartAt : undefined;
    const data: Prisma.DeliveryTripUpdateManyMutationInput = {
      ...(plannedStartAt === undefined
        ? {}
        : { plannedStartAt: new Date(plannedStartAt) }),
      ...(dto.vehicleId === undefined ? {} : { vehicleId: dto.vehicleId }),
      ...(dto.driverId === undefined
        ? {}
        : {
            driverId: dto.driverId,
            driverUserId: driver?.userId ?? null,
            driverVersion: driver ? BigInt(driver.version) : null,
          }),
      ...(dto.vehicleId === undefined && dto.driverId === undefined
        ? {}
        : {
            vehicleId,
            driverId,
            driverUserId: driver?.userId ?? null,
            driverVersion: driver ? BigInt(driver.version) : null,
          }),
      version: { increment: 1 },
      updatedAt: new Date(),
    };
    try {
      await this.prisma.$transaction(async (tx) => {
        const changed = await tx.deliveryTrip.updateMany({
          where: {
            id: tripId,
            tenantId: user.tenantId,
            version: BigInt(dto.expectedVersion),
            status: 'DRAFT',
            deletedAt: null,
          },
          data,
        });
        if (changed.count !== 1) {
          const actual = await tx.deliveryTrip.findFirst({
            where: { id: tripId, tenantId: user.tenantId },
            select: { version: true },
          });
          if (actual)
            this.assertVersion(tripId, dto.expectedVersion, actual.version);
          throw new EntityNotFoundError('DeliveryTrip', tripId);
        }
        const trip = await tx.deliveryTrip.findFirstOrThrow({
          where: { id: tripId, tenantId: user.tenantId },
        });
        const pending = await tx.tripOperation.findFirst({
          where: { activeLock: `${user.tenantId}:${tripId}` },
          select: { requestId: true },
        });
        if (pending) {
          throw new TripConflictError('TRIP_OPERATION_PENDING', {
            requestId: pending.requestId,
          });
        }
        await tx.tripOperation.create({
          data: {
            tenantId: user.tenantId,
            tripId,
            requestId: dto.requestId,
            actorId: user.id,
            kind,
            status: 'COMPLETED',
            payloadHash: hash,
            payload: { kind, tripId, ...dto },
            result: {
              tripId,
              requestId: dto.requestId,
              kind,
              status: 'COMPLETED',
              version: toSafeVersion(trip.version),
              results: [],
            },
          },
        });
      });
    } catch (error) {
      const raced = await this.replay(
        user.tenantId,
        dto.requestId,
        user.id,
        hash,
      );
      if (raced) return this.requireTrip(user.tenantId, tripId);
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new BusinessRuleViolationError('TRIP_REQUEST_ID_ALREADY_USED', {
          requestId: dto.requestId,
        });
      }
      throw error;
    }
    return this.requireTrip(user.tenantId, tripId);
  }

  private async updateLocalFields(
    user: AuthenticatedUser,
    tripId: string,
    dto: UpdateTripDto | AssignmentDto,
    authorization: string,
    kind: 'UPDATE' | 'ASSIGNMENT',
  ) {
    const current = await this.prisma.deliveryTrip.findFirst({
      where: { id: tripId, tenantId: user.tenantId, deletedAt: null },
    });
    if (!current) throw new EntityNotFoundError('DeliveryTrip', tripId);
    this.assertVersion(tripId, dto.expectedVersion, current.version);
    if (current.status !== 'DRAFT') {
      throw new InvalidStateTransitionError(
        'DeliveryTrip',
        current.status,
        kind,
      );
    }
    const pendingOperation = await this.prisma.tripOperation.findFirst({
      where: { activeLock: `${user.tenantId}:${tripId}` },
      select: { requestId: true },
    });
    if (pendingOperation) {
      throw new TripConflictError('TRIP_OPERATION_PENDING', {
        requestId: pendingOperation.requestId,
      });
    }
    if (current.version >= BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new ConcurrencyConflictError(
        'DeliveryTrip',
        tripId,
        dto.expectedVersion,
        toSafeVersion(current.version),
      );
    }
    if (dto.vehicleId)
      await this.masterData.vehicle(dto.vehicleId, authorization);

    const data: Prisma.DeliveryTripUpdateManyMutationInput = {
      ...('plannedStartAt' in dto && dto.plannedStartAt !== undefined
        ? { plannedStartAt: new Date(dto.plannedStartAt) }
        : {}),
      ...(dto.vehicleId === undefined ? {} : { vehicleId: dto.vehicleId }),
      ...(dto.driverId === null
        ? { driverId: null, driverUserId: null, driverVersion: null }
        : {}),
      version: { increment: 1 },
      updatedAt: new Date(),
    };
    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.deliveryTrip.updateMany({
        where: {
          id: tripId,
          tenantId: user.tenantId,
          version: BigInt(dto.expectedVersion),
          status: 'DRAFT',
          deletedAt: null,
        },
        data,
      });
      if (changed.count !== 1) {
        const actual = await tx.deliveryTrip.findFirst({
          where: { id: tripId, tenantId: user.tenantId },
          select: { version: true },
        });
        if (actual)
          this.assertVersion(tripId, dto.expectedVersion, actual.version);
        throw new EntityNotFoundError('DeliveryTrip', tripId);
      }
      const pending = await tx.tripOperation.findFirst({
        where: { activeLock: `${user.tenantId}:${tripId}` },
        select: { requestId: true },
      });
      if (pending) {
        throw new TripConflictError('TRIP_OPERATION_PENDING', {
          requestId: pending.requestId,
        });
      }
    });
    return this.requireTrip(user.tenantId, tripId);
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
      throw new TripConflictError('REQUEST_ID_REPLAY_MISMATCH', {
        requestId,
      });
    }
    return operation;
  }

  private async requireTrip(tenantId: string, tripId: string) {
    const trip = await this.queries.get(tenantId, tripId);
    if (!trip) throw new EntityNotFoundError('DeliveryTrip', tripId);
    return trip;
  }

  private assertVersion(
    tripId: string,
    expected: number,
    actual: bigint,
  ): void {
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
