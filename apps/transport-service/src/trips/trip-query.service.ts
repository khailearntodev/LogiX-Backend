import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../database/prisma.service.js';
import { FulfillmentClient } from '../integrations/fulfillment.client.js';
import { MasterDataClient } from '../integrations/master-data.client.js';
import { toSafeCounter, toSafeVersion } from './trip-serialization.js';
import type { TripListQueryDto } from './trip.dto.js';
import { tripStatusSchema, tripStopStatusSchema } from './trip-status.js';

function stopDemand(
  stop: { shipmentId: string; deletedAt: Date | null },
  memberships: Array<{
    id: string;
    shipmentId: string;
    state: string;
    assignedAt: Date;
    removedAt: Date | null;
    deletedAt: Date | null;
    weight: Prisma.Decimal;
    volume: Prisma.Decimal;
  }>,
) {
  const related = memberships.filter(
    (membership) => membership.shipmentId === stop.shipmentId,
  );
  const candidates =
    stop.deletedAt === null
      ? related.filter(
          (membership) =>
            (membership.state === 'ACTIVE' ||
              membership.state === 'RELEASE_PENDING') &&
            membership.removedAt === null &&
            membership.deletedAt === null,
        )
      : related.filter(
          (membership) => membership.assignedAt <= stop.deletedAt!,
        );
  const selected = candidates.sort(
    (left, right) =>
      right.assignedAt.getTime() - left.assignedAt.getTime() ||
      right.id.localeCompare(left.id),
  )[0];
  return selected
    ? {
        weight: selected.weight.toFixed(3),
        volume: selected.volume.toFixed(6),
      }
    : { weight: null, volume: null };
}

@Injectable()
export class TripQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fulfillment: FulfillmentClient,
    private readonly masterData: MasterDataClient,
  ) {}

  async list(tenantId: string, query: TripListQueryDto) {
    const where: Prisma.DeliveryTripWhereInput = {
      tenantId,
      deletedAt: null,
      ...(query.warehouseId ? { warehouseId: query.warehouseId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.vehicleId ? { vehicleId: query.vehicleId } : {}),
      ...(query.driverId ? { driverId: query.driverId } : {}),
      ...(query.search
        ? { tripNumber: { contains: query.search, mode: 'insensitive' } }
        : {}),
      ...(query.plannedStartFrom || query.plannedStartTo
        ? {
            plannedStartAt: {
              ...(query.plannedStartFrom
                ? { gte: new Date(query.plannedStartFrom) }
                : {}),
              ...(query.plannedStartTo
                ? { lte: new Date(query.plannedStartTo) }
                : {}),
            },
          }
        : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.deliveryTrip.findMany({
        where,
        orderBy: [{ plannedStartAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.deliveryTrip.count({ where }),
    ]);
    return {
      items: rows.map((trip) => this.tripListView(trip)),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async get(tenantId: string, tripId: string, database: Prisma.TransactionClient = this.prisma) {
    const trip = await database.deliveryTrip.findFirst({
      where: { id: tripId, tenantId, deletedAt: null },
      include: {
        dispatches: { orderBy: { createdAt: 'desc' }, take: 1 },
        shipments: { orderBy: [{ assignedAt: 'asc' }, { id: 'asc' }] },
        stops: { orderBy: [{ plannedSequence: 'asc' }, { id: 'asc' }] },
      },
    });
    if (!trip) return null;
    return {
      ...this.tripListView(trip),
      actualStartAt: trip.actualStartAt,
      completedAt: trip.completedAt,
      approvedRoutePlanId: trip.approvedRoutePlanId,
      dispatchVersion: toSafeCounter(trip.dispatchVersion),
      dispatchOperation: trip.dispatches[0] ? {
        requestId: trip.dispatches[0].idempotencyKey,
        status: trip.dispatches[0].status,
        stage: trip.dispatches[0].stage,
      } : null,
      dispatchedAt: trip.dispatchedAt,
      canceledAt: trip.canceledAt,
      cancelReason: trip.cancelReason,
      depotSnapshot: trip.depotSnapshot,
      vehicleSnapshot: trip.vehicleSnapshot,
      driverSnapshot: trip.driverSnapshot,
      createdAt: trip.createdAt,
      updatedAt: trip.updatedAt,
      driverUserId: trip.driverUserId,
      driverVersion:
        trip.driverVersion === null ? null : toSafeVersion(trip.driverVersion),
      shipments: trip.shipments.map((membership) => ({
        id: membership.id,
        tripId: membership.tripId,
        shipmentId: membership.shipmentId,
        orderId: membership.orderId,
        warehouseId: membership.warehouseId,
        shipmentVersion:
          membership.shipmentVersion === null
            ? null
            : toSafeVersion(membership.shipmentVersion),
        orderVersion:
          membership.orderVersion === null
            ? null
            : toSafeVersion(membership.orderVersion),
        state: membership.state,
        weight: membership.weight.toFixed(3),
        volume: membership.volume.toFixed(6),
        assignedAt: membership.assignedAt,
        removedAt: membership.removedAt,
        claimReceipt: membership.claimReceipt,
        releaseReceipt: membership.releaseReceipt,
        shipmentSnapshot: membership.shipmentSnapshot,
      })),
      stops: trip.stops.map((stop) => ({
        id: stop.id,
        tenantId: stop.tenantId,
        tripId: stop.tripId,
        shipmentId: stop.shipmentId,
        deliveryAddressId: stop.deliveryAddressId,
        addressSnapshot: stop.addressSnapshot,
        latitude: stop.latitude?.toFixed(6) ?? null,
        longitude: stop.longitude?.toFixed(6) ?? null,
        ...stopDemand(stop, trip.shipments),
        plannedSequence: stop.plannedSequence,
        approvedSequence: stop.approvedSequence,
        status: tripStopStatusSchema.parse(stop.status),
        currentAttempt: stop.currentAttempt,
        arrivedAt: stop.arrivedAt,
        completedAt: stop.completedAt,
        createdAt: stop.createdAt,
        updatedAt: stop.updatedAt,
        version: toSafeVersion(stop.version),
        deletedAt: stop.deletedAt,
      })),
    };
  }

  async eligibleShipments(
    tenantId: string,
    warehouseId: string,
    page: number,
    pageSize: number,
    authorization: string,
  ) {
    await this.masterData.warehouse(tenantId, warehouseId, authorization);
    const memberships = await this.prisma.tripShipment.findMany({
      where: {
        tenantId,
        warehouseId,
        removedAt: null,
        state: { in: ['CLAIM_PENDING', 'ACTIVE', 'RELEASE_PENDING'] },
      },
      select: { shipmentId: true },
      distinct: ['shipmentId'],
    });
    return this.fulfillment.pool({
      tenantId,
      warehouseId,
      page,
      pageSize,
      excludedShipmentIds: memberships.map(({ shipmentId }) => shipmentId),
    });
  }

  private tripListView(trip: {
    id: string;
    tenantId: string;
    tripNumber: string;
    warehouseId: string;
    vehicleId: string | null;
    driverId: string | null;
    depotSnapshot: Prisma.JsonValue;
    vehicleSnapshot: Prisma.JsonValue | null;
    driverSnapshot: Prisma.JsonValue | null;
    status: string;
    plannedStartAt: Date;
    totalWeight: Prisma.Decimal;
    totalVolume: Prisma.Decimal;
    version: bigint;
  }) {
    return {
      id: trip.id,
      tenantId: trip.tenantId,
      tripNumber: trip.tripNumber,
      warehouseId: trip.warehouseId,
      vehicleId: trip.vehicleId,
      driverId: trip.driverId,
      status: tripStatusSchema.parse(trip.status),
      plannedStartAt: trip.plannedStartAt,
      totalWeight: trip.totalWeight.toFixed(3),
      totalVolume: trip.totalVolume.toFixed(6),
      version: toSafeVersion(trip.version),
      depotSnapshot: trip.depotSnapshot,
      vehicleSnapshot: trip.vehicleSnapshot,
      driverSnapshot: trip.driverSnapshot,
    };
  }
}
