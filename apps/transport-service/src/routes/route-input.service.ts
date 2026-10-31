import { Injectable } from '@nestjs/common';
import { BusinessRuleViolationError, EntityNotFoundError } from '@logix/errors';
import { z } from 'zod';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { MasterDataClient } from '../integrations/master-data.client.js';
import { FulfillmentClient } from '../integrations/fulfillment.client.js';
import { DownstreamError, DownstreamServiceError } from '../integrations/downstream-error.js';
import { TripConflictError } from '../trips/trip-conflict.error.js';
import { toSafeVersion } from '../trips/trip-serialization.js';
import { coordinate, decimal, routeHash } from './route-domain.js';

const depotSchema = z.object({
  name: z.string().min(1), addressLine: z.string().min(1),
  latitude: z.string(), longitude: z.string(),
});
const addressSchema = z.object({ addressLine: z.string().min(1), latitude: z.string(), longitude: z.string() }).passthrough();
const claimSchema = z.object({ claimId: z.string().uuid() });

@Injectable()
export class RouteInputService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly masterData: MasterDataClient,
    private readonly fulfillment: FulfillmentClient,
  ) {}

  async current(tenantId: string, tripId: string, authorization?: string) {
    const trip = await this.prisma.deliveryTrip.findFirst({
      where: { id: tripId, tenantId, deletedAt: null },
      include: {
        shipments: { where: { removedAt: null, deletedAt: null }, orderBy: { id: 'asc' } },
        stops: { where: { deletedAt: null }, orderBy: [{ plannedSequence: 'asc' }, { id: 'asc' }] },
      },
    });
    if (!trip) throw new EntityNotFoundError('DeliveryTrip', tripId);
    if (!trip.vehicleId || !trip.driverId || !trip.driverUserId)
      throw new BusinessRuleViolationError('TRIP_RESOURCES_REQUIRED');
    if (!trip.shipments.length || trip.shipments.some((row) => row.state !== 'ACTIVE') || !trip.stops.length ||
      trip.stops.length !== trip.shipments.length)
      throw new BusinessRuleViolationError('TRIP_MANIFEST_NOT_READY');
    const [warehouse, vehicle, driver] = await Promise.all([
      this.masterData.warehouse(tenantId, trip.warehouseId, authorization),
      this.masterData.vehicle(trip.vehicleId, authorization, tenantId),
      this.masterData.driverForTrip(tenantId, trip.driverId),
    ]);
    void warehouse;
    if (driver.userId !== trip.driverUserId)
      throw new TripConflictError('DRIVER_IDENTITY_BINDING_CHANGED');
    const capacityWeight = decimal(vehicle.capacityWeight, 3, true);
    const capacityVolume = decimal(vehicle.capacityVolume, 6, true);
    const totalWeight = trip.shipments.reduce((sum, row) => sum.plus(row.weight), new Prisma.Decimal(0));
    const totalVolume = trip.shipments.reduce((sum, row) => sum.plus(row.volume), new Prisma.Decimal(0));
    if (totalWeight.gt(capacityWeight) || totalVolume.gt(capacityVolume))
      throw new BusinessRuleViolationError('TRIP_CAPACITY_EXCEEDED');
    if (!trip.totalWeight.eq(totalWeight) || !trip.totalVolume.eq(totalVolume))
      throw new BusinessRuleViolationError('TRIP_TOTALS_MISMATCH');
    for (const membership of trip.shipments) {
      const claim = claimSchema.safeParse(membership.claimReceipt);
      if (!claim.success || membership.shipmentVersion === null || membership.warehouseId !== trip.warehouseId)
        throw new BusinessRuleViolationError('TRIP_MEMBERSHIP_BINDING_INVALID');
      try {
        await this.fulfillment.assertReady(tenantId, tripId, membership.shipmentId, claim.data.claimId, toSafeVersion(membership.shipmentVersion));
      } catch (error) {
        if (error instanceof DownstreamError && error.definite) throw new TripConflictError('SHIPMENT_NOT_READY_OR_CLAIM_CHANGED');
        if (error instanceof DownstreamError) throw new DownstreamServiceError('Fulfillment', error.status);
        throw error;
      }
    }
    const depot = depotSchema.safeParse(trip.depotSnapshot);
    if (!depot.success) throw new BusinessRuleViolationError('TRIP_DEPOT_SNAPSHOT_INVALID');
    coordinate(depot.data.latitude, 90);
    coordinate(depot.data.longitude, 180);
    const input = {
      contractVersion: 1,
      tenantId, tripId, tripVersion: toSafeVersion(trip.version),
      warehouseId: trip.warehouseId,
      vehicleId: vehicle.id,
      plannedStartAt: trip.plannedStartAt.toISOString(),
      objective: 'MINIMIZE_ROAD_DISTANCE',
      solverVersion: null,
      configVersion: 'route-v1',
      providerVersion: null,
      options: { returnToDepot: true },
      driver: { id: driver.id, userId: driver.userId, version: driver.version },
      depot: {
        name: depot.data.name, address: depot.data.addressLine,
        latitude: depot.data.latitude, longitude: depot.data.longitude,
      },
      vehicle: {
        vehicleId: vehicle.id, version: vehicle.version, plateNumber: vehicle.licensePlate,
        capacityWeight, capacityVolume,
      },
      stops: trip.stops.map((stop, index) => {
        const membership = trip.shipments.find((row) => row.shipmentId === stop.shipmentId);
        const address = addressSchema.safeParse(stop.addressSnapshot);
        if (!membership || membership.shipmentVersion === null || !address.success || stop.status !== 'PENDING')
          throw new BusinessRuleViolationError('TRIP_STOP_SNAPSHOT_INVALID');
        coordinate(address.data.latitude, 90);
        coordinate(address.data.longitude, 180);
        if (!stop.latitude?.eq(address.data.latitude) || !stop.longitude?.eq(address.data.longitude))
          throw new BusinessRuleViolationError('TRIP_STOP_COORDINATE_MISMATCH');
        return {
          stopId: stop.id, shipmentId: stop.shipmentId,
          shipmentVersion: toSafeVersion(membership.shipmentVersion),
          addressSnapshot: address.data,
          demandWeight: decimal(membership.weight.toString(), 3),
          demandVolume: decimal(membership.volume.toString(), 6),
          sequence: index + 1,
        };
      }),
    };
    return {
      trip, input, hash: routeHash(input),
      vehicleSnapshot: { ...vehicle, capacityWeight, capacityVolume },
      driverSnapshot: driver,
    };
  }
}

export type CurrentRouteInput = Awaited<ReturnType<RouteInputService['current']>>;
