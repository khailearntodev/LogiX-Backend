import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from '@logix/auth';
import {
  BusinessRuleViolationError,
  EntityNotFoundError,
  TenantAccessDeniedError,
} from '@logix/errors';
import { TRANSPORT_CONTRACT_VERSION } from '@logix/messaging';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../database/prisma.service.js';
import { lockTrip } from '../routes/route-domain.js';
import { TripConflictError } from '../trips/trip-conflict.error.js';
import { stableHash, toSafeVersion } from '../trips/trip-serialization.js';
import type {
  DriverActionCommandDto,
  DriverActionPreviewDto,
  DriverTripListQuery,
} from './driver-trip.dto.js';
import { DriverActionPreviewTokenService } from './driver-action-preview-token.service.js';

const ACTION = { DELIVER: 'DELIVER', FAIL: 'FAIL' } as const;
const RESULT = { DELIVERED: 'DELIVERED', FAILED: 'FAILED' } as const;

@Injectable()
export class DriverTripService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly previews: DriverActionPreviewTokenService,
  ) {}

  async list(user: AuthenticatedUser, query: DriverTripListQuery) {
    if (query.driverId && !user.isSuperAdmin)
      throw new TenantAccessDeniedError();
    const scopeStatus =
      query.scope === 'current'
        ? ['IN_PROGRESS']
        : query.scope === 'history'
          ? ['COMPLETED', 'CANCELED']
          : undefined;
    const where: Prisma.DeliveryTripWhereInput = {
      tenantId: user.tenantId,
      deletedAt: null,
      ...(user.isSuperAdmin
        ? query.driverId
          ? { driverId: query.driverId }
          : {}
        : { driverUserId: user.id }),
      ...(scopeStatus ? { status: { in: scopeStatus } } : {}),
    };
    const [trips, total] = await this.prisma.$transaction([
      this.prisma.deliveryTrip.findMany({
        where,
        include: {
          stops: {
            where: { deletedAt: null },
            orderBy: [{ approvedSequence: 'asc' }, { id: 'asc' }],
          },
        },
        orderBy: [{ plannedStartAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.deliveryTrip.count({ where }),
    ]);
    return {
      items: trips.map((trip) => {
        const stops = trip.stops;
        const next = stops.find((stop) => stop.status === 'PENDING');
        return {
          tripId: trip.id,
          tripNumber: trip.tripNumber,
          status: trip.status,
          plannedStartAt: trip.plannedStartAt,
          warehouseId: trip.warehouseId,
          vehicleSnapshot: trip.vehicleSnapshot,
          driverSnapshot: trip.driverSnapshot,
          version: toSafeVersion(trip.version),
          stopCount: stops.length,
          completedStopCount: stops.filter(
            (stop) => stop.status === 'DELIVERED' || stop.status === 'FAILED',
          ).length,
          nextStopId: next?.id ?? null,
          nextApprovedSequence: next?.approvedSequence ?? null,
        };
      }),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async detail(user: AuthenticatedUser, tripId: string) {
    const trip = await this.prisma.deliveryTrip.findFirst({
      where: { id: tripId, tenantId: user.tenantId, deletedAt: null },
      include: {
        stops: {
          where: { deletedAt: null },
          orderBy: [{ approvedSequence: 'asc' }, { id: 'asc' }],
        },
        shipments: {
          where: { deletedAt: null },
          orderBy: [{ assignedAt: 'asc' }, { id: 'asc' }],
        },
      },
    });
    if (!trip) throw new EntityNotFoundError('DeliveryTrip', tripId);
    this.assertAssigned(user, trip.driverUserId);
    const next = trip.stops.find((stop) => stop.status === 'PENDING');
    const shipmentById = new Map(
      trip.shipments.map((membership) => [
        membership.shipmentId,
        membership.shipmentSnapshot,
      ]),
    );
    return {
      tripId: trip.id,
      tripNumber: trip.tripNumber,
      status: trip.status,
      plannedStartAt: trip.plannedStartAt,
      actualStartAt: trip.actualStartAt,
      completedAt: trip.completedAt,
      warehouseId: trip.warehouseId,
      depotSnapshot: trip.depotSnapshot,
      vehicleSnapshot: trip.vehicleSnapshot,
      driverSnapshot: trip.driverSnapshot,
      approvedRoutePlanId: trip.approvedRoutePlanId,
      version: toSafeVersion(trip.version),
      nextStopId: next?.id ?? null,
      stops: trip.stops.map((stop) => {
        const address = stop.addressSnapshot as Record<string, unknown>;
        const shipment = shipmentById.get(stop.shipmentId);
        const shipmentSnapshot =
          shipment && typeof shipment === 'object' && !Array.isArray(shipment)
            ? (shipment as Record<string, unknown>)
            : {};
        return {
          stopId: stop.id,
          shipmentId: stop.shipmentId,
          shipmentNumber: shipmentSnapshot.shipmentNumber ?? null,
          approvedSequence: stop.approvedSequence,
          status: stop.status,
          version: toSafeVersion(stop.version),
          isNext: stop.id === next?.id,
          contact: {
            recipientName: address.recipientName ?? null,
            phone: address.phone ?? null,
            addressLine: address.addressLine ?? null,
            ward: address.ward ?? null,
            district: address.district ?? null,
            province: address.province ?? null,
            postalCode: address.postalCode ?? null,
            deliveryNote: address.deliveryNote ?? null,
          },
        };
      }),
    };
  }

  async preview(
    user: AuthenticatedUser,
    tripId: string,
    stopId: string,
    dto: DriverActionPreviewDto,
  ) {
    if (!user.isSuperAdmin)
      throw new TenantAccessDeniedError();
    const { trip, stop } = await this.loadActionable(
      this.prisma,
      user,
      tripId,
      stopId,
      dto.expectedTripVersion,
      dto.expectedStopVersion,
    );
    if (dto.action === ACTION.FAIL && !dto.reason)
      throw new BusinessRuleViolationError('DELIVERY_FAILURE_REASON_REQUIRED');
    const payloadHash = this.commandPayloadHash({
      user,
      tripId,
      stopId,
      action: dto.action,
      expectedTripVersion: dto.expectedTripVersion,
      expectedStopVersion: dto.expectedStopVersion,
      reason: dto.reason ?? null,
      actingReason: dto.actingReason,
      assignedDriverId: trip.driverId!,
      assignedDriverUserId: trip.driverUserId!,
    });
    return {
      tripId,
      stopId,
      action: dto.action,
      statusBefore: stop.status,
      statusAfter:
        dto.action === ACTION.DELIVER ? RESULT.DELIVERED : RESULT.FAILED,
      expectedTripVersion: dto.expectedTripVersion,
      expectedStopVersion: dto.expectedStopVersion,
      assignedDriverId: trip.driverId,
      actingReason: dto.actingReason,
      reason: dto.reason ?? null,
      ...this.previews.issue({
        tenantId: user.tenantId,
        actorId: user.id,
        tripId,
        payloadHash,
      }),
    };
  }

  async deliver(
    user: AuthenticatedUser,
    tripId: string,
    stopId: string,
    dto: DriverActionCommandDto,
  ) {
    return this.apply(user, tripId, stopId, dto, ACTION.DELIVER);
  }

  async fail(
    user: AuthenticatedUser,
    tripId: string,
    stopId: string,
    dto: DriverActionCommandDto,
  ) {
    return this.apply(user, tripId, stopId, dto, ACTION.FAIL);
  }

  private async apply(
    user: AuthenticatedUser,
    tripId: string,
    stopId: string,
    dto: DriverActionCommandDto,
    action: typeof ACTION[keyof typeof ACTION],
  ) {
    const actorMode = user.isSuperAdmin ? 'SUPER_ADMIN' : 'DRIVER';
    if (action === ACTION.FAIL && !dto.reason)
      throw new BusinessRuleViolationError('DELIVERY_FAILURE_REASON_REQUIRED');
    if (action === ACTION.DELIVER && dto.reason !== undefined)
      throw new BusinessRuleViolationError('DELIVERY_SUCCESS_REASON_NOT_ALLOWED');
    if (user.isSuperAdmin && (!dto.previewToken || !dto.actingReason))
      throw new BusinessRuleViolationError('DRIVER_ACTION_PREVIEW_REQUIRED');
    if (
      !user.isSuperAdmin &&
      (dto.previewToken !== undefined || dto.actingReason !== undefined)
    )
      throw new BusinessRuleViolationError('DRIVER_CANNOT_ACT_AS_ADMIN');

    const replay = async (database: Prisma.TransactionClient | PrismaService) => {
      const prior = await database.deliveryAttempt.findFirst({
        where: { tenantId: user.tenantId, requestId: dto.requestId },
      });
      if (!prior) return null;
      const requestHash = this.commandPayloadHash({
        user,
        tripId,
        stopId,
        action,
        expectedTripVersion: dto.expectedTripVersion,
        expectedStopVersion: dto.expectedStopVersion,
        reason: dto.reason ?? null,
        actingReason: dto.actingReason ?? null,
        assignedDriverId: prior.actorDriverId,
        assignedDriverUserId: prior.assigneeUserId,
      });
      if (
        prior.actorUserId !== user.id ||
        prior.actorMode !== actorMode ||
        prior.payloadHash !== requestHash ||
        !prior.receipt
      )
        throw new TripConflictError('DELIVERY_REQUEST_ID_CONFLICT');
      return prior.receipt;
    };
    const existingReceipt = await replay(this.prisma);
    if (existingReceipt) return existingReceipt;

    return this.prisma.$transaction(async (tx) => {
      await lockTrip(tx, user.tenantId, tripId);
      const racedReceipt = await replay(tx);
      if (racedReceipt) return racedReceipt;
      const { trip, stop } = await this.loadActionable(
        tx,
        user,
        tripId,
        stopId,
        dto.expectedTripVersion,
        dto.expectedStopVersion,
      );
      this.assertAssigned(user, trip.driverUserId);
      const requestHash = this.commandPayloadHash({
        user,
        tripId,
        stopId,
        action,
        expectedTripVersion: dto.expectedTripVersion,
        expectedStopVersion: dto.expectedStopVersion,
        reason: dto.reason ?? null,
        actingReason: dto.actingReason ?? null,
        assignedDriverId: trip.driverId!,
        assignedDriverUserId: trip.driverUserId!,
      });
      if (user.isSuperAdmin) {
        const payloadHash = this.commandPayloadHash({
          user,
          tripId,
          stopId,
          action,
          expectedTripVersion: dto.expectedTripVersion,
          expectedStopVersion: dto.expectedStopVersion,
          reason: dto.reason ?? null,
          actingReason: dto.actingReason!,
          assignedDriverId: trip.driverId!,
          assignedDriverUserId: trip.driverUserId!,
        });
        this.previews.verify(dto.previewToken!, {
          tenantId: user.tenantId,
          actorId: user.id,
          tripId,
          payloadHash,
        });
      }

      const occurredAt = new Date();
      const toStatus =
        action === ACTION.DELIVER ? RESULT.DELIVERED : RESULT.FAILED;
      const remainingPending = await tx.tripStop.count({
        where: {
          tenantId: user.tenantId,
          tripId,
          deletedAt: null,
          status: 'PENDING',
          id: { not: stopId },
        },
      });
      const completesTrip = remainingPending === 0;
      const updatedStop = await tx.tripStop.update({
        where: { id: stopId },
        data: {
          status: toStatus,
          completedAt: occurredAt,
          version: { increment: 1 },
        },
      });
      const updatedTrip = await tx.deliveryTrip.update({
        where: { id: tripId },
        data: {
          ...(completesTrip
            ? { status: 'COMPLETED', completedAt: occurredAt }
            : {}),
          version: { increment: 1 },
        },
      });
      const attemptId = randomUUID();
      const result = {
        requestId: dto.requestId,
        tripId,
        tripStopId: stopId,
        shipmentId: stop.shipmentId,
        driverId: trip.driverId,
        assigneeUserId: trip.driverUserId,
        actorUserId: user.id,
        actorMode,
        status: toStatus,
        reason: dto.reason ?? null,
        actingReason: dto.actingReason ?? null,
        attempt: 1,
        occurredAt: occurredAt.toISOString(),
        tripVersion: toSafeVersion(updatedTrip.version),
        stopVersion: toSafeVersion(updatedStop.version),
      };
      await tx.deliveryAttempt.create({
        data: {
          id: attemptId,
          tenantId: user.tenantId,
          tripStopId: stopId,
          shipmentId: stop.shipmentId,
          attemptNumber: 1,
          requestId: dto.requestId,
          status: toStatus,
          reason: dto.reason ?? null,
          actorDriverId: trip.driverId!,
          actorUserId: user.id,
          assigneeUserId: trip.driverUserId!,
          actorMode,
          actingReason: dto.actingReason ?? null,
          payloadHash: requestHash,
          receipt: result,
          occurredAt,
          correlationId: dto.requestId,
        },
      });
      await tx.outboxEvent.create({
        data: {
          tenantId: user.tenantId,
          eventType:
            action === ACTION.DELIVER ? 'DeliveryCompleted' : 'DeliveryFailed',
          eventVersion: 2,
          aggregateType: 'DeliveryTrip',
          aggregateId: tripId,
          aggregateVersion: updatedTrip.version,
          occurredAt,
          correlationId: dto.requestId,
          causationId: dto.requestId,
          payload: {
            contractVersion: TRANSPORT_CONTRACT_VERSION,
            tenantId: user.tenantId,
            tripId,
            stopId,
            shipmentId: stop.shipmentId,
            driverId: trip.driverId,
            assigneeUserId: trip.driverUserId,
            attempt: 1,
            outcome: toStatus,
            occurredAt: occurredAt.toISOString(),
            requestId: dto.requestId,
            reason: dto.reason ?? null,
          },
        },
      });
      return result;
    });
  }

  private async loadActionable(
    database: Prisma.TransactionClient | PrismaService,
    user: AuthenticatedUser,
    tripId: string,
    stopId: string,
    expectedTripVersion: number,
    expectedStopVersion: number,
  ) {
    const trip = await database.deliveryTrip.findFirst({
      where: { id: tripId, tenantId: user.tenantId, deletedAt: null },
      include: {
        stops: {
          where: { deletedAt: null, status: 'PENDING' },
          orderBy: [{ approvedSequence: 'asc' }, { id: 'asc' }],
          take: 1,
        },
      },
    });
    if (!trip) throw new EntityNotFoundError('DeliveryTrip', tripId);
    if (trip.status !== 'IN_PROGRESS')
      throw new TripConflictError('DELIVERY_TRIP_NOT_IN_PROGRESS');
    if (!trip.driverId || !trip.driverUserId)
      throw new TripConflictError('DELIVERY_TRIP_DRIVER_UNASSIGNED');
    const stop = await database.tripStop.findFirst({
      where: {
        id: stopId,
        tenantId: user.tenantId,
        tripId,
        deletedAt: null,
      },
    });
    if (!stop) throw new EntityNotFoundError('TripStop', stopId);
    if (
      trip.stops[0]?.id !== stopId ||
      trip.stops[0]?.approvedSequence === null ||
      stop.status !== 'PENDING'
    )
      throw new TripConflictError('DELIVERY_STOP_NOT_NEXT');
    if (
      trip.version !== BigInt(expectedTripVersion) ||
      stop.version !== BigInt(expectedStopVersion)
    )
      throw new TripConflictError('DELIVERY_VERSION_CONFLICT');
    return { trip, stop };
  }

  private assertAssigned(user: AuthenticatedUser, driverUserId: string | null) {
    if (!user.isSuperAdmin && driverUserId !== user.id)
      throw new TenantAccessDeniedError();
  }

  private commandPayloadHash(value: {
    user: AuthenticatedUser;
    tripId: string;
    stopId: string;
    action: string;
    expectedTripVersion: number;
    expectedStopVersion: number;
    reason: string | null;
    actingReason: string | null;
    assignedDriverId: string | null;
    assignedDriverUserId: string | null;
  }) {
    return stableHash({
      tenantId: value.user.tenantId,
      actorId: value.user.id,
      actorMode: value.user.isSuperAdmin ? 'SUPER_ADMIN' : 'DRIVER',
      tripId: value.tripId,
      stopId: value.stopId,
      action: value.action,
      expectedTripVersion: value.expectedTripVersion,
      expectedStopVersion: value.expectedStopVersion,
      reason: value.reason,
      actingReason: value.actingReason,
      assignedDriverId: value.assignedDriverId,
      assignedDriverUserId: value.assignedDriverUserId,
    });
  }
}
