import { randomUUID } from 'node:crypto';
import type { PrismaService } from '../database/prisma.service.js';
import type { FulfillmentClient } from '../integrations/fulfillment.client.js';
import type { MasterDataClient } from '../integrations/master-data.client.js';
import { TripQueryService } from './trip-query.service.js';

describe('Transport trip queries', () => {
  it('excludes pending, active, and releasing membership before asking Fulfillment to count/page', async () => {
    const tenantId = randomUUID();
    const warehouseId = randomUUID();
    const pending = randomUUID();
    const active = randomUUID();
    const releasing = randomUUID();
    const released = randomUUID();
    const findMany = vi
      .fn()
      .mockResolvedValue([
        { shipmentId: pending },
        { shipmentId: active },
        { shipmentId: releasing },
      ]);
    const pool = vi.fn().mockResolvedValue({
      items: [],
      total: 0,
      page: 2,
      pageSize: 20,
    });
    const masterData = {
      warehouse: vi.fn().mockResolvedValue({ id: warehouseId }),
    };
    const service = new TripQueryService(
      {
        tripShipment: { findMany },
      } as unknown as PrismaService,
      { pool } as unknown as FulfillmentClient,
      masterData as unknown as MasterDataClient,
    );

    await service.eligibleShipments(
      tenantId,
      warehouseId,
      2,
      20,
      'Bearer trusted-user-token',
    );

    expect(findMany).toHaveBeenCalledWith({
      where: {
        tenantId,
        warehouseId,
        removedAt: null,
        state: { in: ['CLAIM_PENDING', 'ACTIVE', 'RELEASE_PENDING'] },
      },
      select: { shipmentId: true },
      distinct: ['shipmentId'],
    });
    expect(pool).toHaveBeenCalledWith({
      tenantId,
      warehouseId,
      page: 2,
      pageSize: 20,
      excludedShipmentIds: [pending, active, releasing],
    });
    expect(pool.mock.invocationCallOrder[0]).toBeGreaterThan(
      masterData.warehouse.mock.invocationCallOrder[0],
    );
    expect([pending, active, releasing]).not.toContain(released);
  });

  it('allowlists stop and trip fields rather than exposing whole Prisma records', async () => {
    const tenantId = randomUUID();
    const tripId = randomUUID();
    const stop = {
      id: randomUUID(),
      tenantId,
      tripId,
      shipmentId: randomUUID(),
      deliveryAddressId: randomUUID(),
      addressSnapshot: { recipientName: 'Receiving' },
      latitude: null,
      longitude: null,
      plannedSequence: 1,
      approvedSequence: null,
      status: 'PENDING',
      currentAttempt: 0,
      arrivedAt: null,
      completedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      version: 1n,
      deletedAt: null,
      secretInternalColumn: 'must-not-leak',
    };
    const trip = {
      id: tripId,
      tenantId,
      tripNumber: 'TR-1',
      warehouseId: randomUUID(),
      vehicleId: null,
      driverId: null,
      driverUserId: null,
      driverVersion: null,
      depotSnapshot: { id: randomUUID() },
      vehicleSnapshot: null,
      driverSnapshot: null,
      status: 'DRAFT',
      plannedStartAt: new Date(),
      actualStartAt: null,
      completedAt: null,
      totalWeight: { toFixed: () => '0.000' },
      totalVolume: { toFixed: () => '0.000000' },
      approvedRoutePlanId: null,
      dispatchVersion: 0n,
      dispatchedAt: null,
      canceledAt: null,
      cancelReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      version: 1n,
      deletedAt: null,
      secretInternalColumn: 'must-not-leak',
      shipments: [],
      dispatches: [],
      stops: [stop],
    };
    const service = new TripQueryService(
      {
        deliveryTrip: { findFirst: vi.fn().mockResolvedValue(trip) },
      } as unknown as PrismaService,
      {} as FulfillmentClient,
      {} as MasterDataClient,
    );

    const detail = (await service.get(tenantId, tripId)) as Record<
      string,
      unknown
    >;
    const [serializedStop] = detail.stops as Array<Record<string, unknown>>;

    expect(detail.secretInternalColumn).toBeUndefined();
    expect(serializedStop.tenantId).toBe(tenantId);
    expect(serializedStop.secretInternalColumn).toBeUndefined();
    expect(Object.keys(serializedStop).sort()).toEqual(
      [
        'addressSnapshot',
        'approvedSequence',
        'arrivedAt',
        'completedAt',
        'createdAt',
        'currentAttempt',
        'deletedAt',
        'deliveryAddressId',
        'id',
        'latitude',
        'longitude',
        'plannedSequence',
        'shipmentId',
        'status',
        'tenantId',
        'tripId',
        'updatedAt',
        'version',
        'volume',
        'weight',
      ].sort(),
    );
  });

  it('derives active and removed-stop demand from the deterministically matching membership', async () => {
    const tenantId = randomUUID();
    const tripId = randomUUID();
    const activeShipmentId = randomUUID();
    const removedShipmentId = randomUUID();
    const missingShipmentId = randomUUID();
    const removedAt = new Date('2026-10-20T10:00:00Z');
    const fixed = (value: string) => ({ toFixed: () => value });
    const membership = (
      id: string,
      shipmentId: string,
      assignedAt: Date,
      state: string,
      removedAtValue: Date | null,
      weight: string,
      volume: string,
    ) => ({
      id,
      shipmentId,
      tripId,
      orderId: null,
      warehouseId: randomUUID(),
      assignedAt,
      state,
      shipmentVersion: null,
      orderVersion: null,
      removedAt: removedAtValue,
      deletedAt: null,
      weight: fixed(weight),
      volume: fixed(volume),
    });
    const stop = (shipmentId: string, deletedAt: Date | null) => ({
      id: randomUUID(),
      tenantId,
      tripId,
      shipmentId,
      deliveryAddressId: randomUUID(),
      addressSnapshot: {},
      latitude: null,
      longitude: null,
      plannedSequence: 1,
      approvedSequence: null,
      status: 'PENDING',
      currentAttempt: 0,
      arrivedAt: null,
      completedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      version: 1n,
      deletedAt,
    });
    const base = {
      id: tripId,
      tenantId,
      tripNumber: 'TR-DERIVE',
      warehouseId: randomUUID(),
      vehicleId: null,
      driverId: null,
      driverUserId: null,
      driverVersion: null,
      depotSnapshot: {},
      vehicleSnapshot: null,
      driverSnapshot: null,
      status: 'DRAFT',
      plannedStartAt: new Date(),
      totalWeight: { toFixed: () => '0.000' },
      totalVolume: { toFixed: () => '0.000000' },
      approvedRoutePlanId: null,
      dispatchVersion: 0n,
      dispatchedAt: null,
      canceledAt: null,
      cancelReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      version: 2n,
    };
    const activeOld = membership(
      randomUUID(),
      activeShipmentId,
      new Date('2026-10-01T10:00:00Z'),
      'RELEASED',
      removedAt,
      '1.000',
      '0.010000',
    );
    const activeCurrent = membership(
      randomUUID(),
      activeShipmentId,
      new Date('2026-10-22T10:00:00Z'),
      'ACTIVE',
      null,
      '8.500',
      '0.850000',
    );
    const removedOld = membership(
      randomUUID(),
      removedShipmentId,
      new Date('2026-10-01T10:00:00Z'),
      'RELEASED',
      removedAt,
      '2.250',
      '0.225000',
    );
    const removedReadded = membership(
      randomUUID(),
      removedShipmentId,
      new Date('2026-10-23T10:00:00Z'),
      'CLAIM_PENDING',
      null,
      '9.000',
      '0.900000',
    );
    const trip = {
      ...base,
      shipments: [activeOld, activeCurrent, removedOld, removedReadded],
      dispatches: [],
      stops: [
        stop(activeShipmentId, null),
        stop(removedShipmentId, removedAt),
        stop(missingShipmentId, removedAt),
      ],
    };
    const service = new TripQueryService(
      {
        deliveryTrip: { findFirst: vi.fn().mockResolvedValue(trip) },
      } as unknown as PrismaService,
      {} as FulfillmentClient,
      {} as MasterDataClient,
    );

    const detail = (await service.get(tenantId, tripId)) as {
      stops: Array<{
        shipmentId: string;
        weight: string | null;
        volume: string | null;
      }>;
    };

    expect(detail.stops).toMatchObject([
      { shipmentId: activeShipmentId, weight: '8.500', volume: '0.850000' },
      { shipmentId: removedShipmentId, weight: '2.250', volume: '0.225000' },
      { shipmentId: missingShipmentId, weight: null, volume: null },
    ]);
  });
});
