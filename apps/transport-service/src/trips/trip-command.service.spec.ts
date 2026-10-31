import { randomUUID } from 'node:crypto';
import { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../database/prisma.service.js';
import type { MasterDataClient } from '../integrations/master-data.client.js';
import type { AuthenticatedUser } from '@logix/auth';
import { TripCommandService } from './trip-command.service.js';
import type { TripQueryService } from './trip-query.service.js';

describe('Transport draft commands', () => {
  it('creates an unassigned draft with a frozen active depot and no premature vehicle/driver snapshot', async () => {
    const tenantId = randomUUID();
    const actorId = randomUUID();
    const warehouseId = randomUUID();
    const requestId = randomUUID();
    const tripId = randomUUID();
    const depot = {
      id: warehouseId,
      code: 'WH-1',
      name: 'North depot',
      addressLine: '12 Road',
      ward: null,
      district: null,
      province: 'Hanoi',
      postalCode: null,
      latitude: '21.000000',
      longitude: '105.000000',
      status: 'ACTIVE',
      version: 4,
    };
    const created: Record<string, unknown>[] = [];
    const operationRows: Record<string, unknown>[] = [];
    const prisma = {
      tripOperation: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
      $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          deliveryTrip: {
            create: vi.fn(
              async ({ data }: { data: Record<string, unknown> }) => {
                created.push(data);
                return data;
              },
            ),
          },
          tripOperation: {
            create: vi.fn(
              async ({ data }: { data: Record<string, unknown> }) => {
                operationRows.push(data);
                return data;
              },
            ),
          },
        }),
      ),
    };
    const queries = {
      get: vi.fn().mockResolvedValue({
        id: tripId,
        tenantId,
        tripNumber: 'TR-1',
        status: 'DRAFT',
        vehicleId: null,
        driverId: null,
        vehicleSnapshot: null,
        driverSnapshot: null,
        depotSnapshot: depot,
        version: 1,
      }),
    };
    const masterData = {
      warehouse: vi.fn().mockResolvedValue(depot),
      vehicle: vi.fn(),
      lockDriver: vi.fn(),
    };
    const service = new TripCommandService(
      prisma as unknown as PrismaService,
      masterData as unknown as MasterDataClient,
      queries as unknown as TripQueryService,
    );
    const user = { id: actorId, tenantId } as AuthenticatedUser;

    const result = await service.create(
      user,
      {
        requestId,
        warehouseId,
        plannedStartAt: '2026-10-26T08:00:00.000Z',
      },
      'Bearer user',
    );

    expect(masterData.warehouse).toHaveBeenCalledWith(
      tenantId,
      warehouseId,
      'Bearer user',
    );
    expect(masterData.vehicle).not.toHaveBeenCalled();
    expect(masterData.lockDriver).not.toHaveBeenCalled();
    expect(created[0]).toMatchObject({
      tenantId,
      tripNumber: expect.stringMatching(/^TR-/),
      warehouseId,
      vehicleId: null,
      driverId: null,
      driverUserId: null,
      driverVersion: null,
      depotSnapshot: depot,
      status: 'DRAFT',
      dispatchVersion: 0n,
    });
    expect((created[0].totalWeight as Prisma.Decimal).toFixed(3)).toBe('0.000');
    expect((created[0].totalVolume as Prisma.Decimal).toFixed(6)).toBe(
      '0.000000',
    );
    expect(result).toMatchObject({
      vehicleSnapshot: null,
      driverSnapshot: null,
    });
    expect(operationRows[0]).toMatchObject({
      tenantId,
      requestId,
      actorId,
      kind: 'CREATE',
      status: 'COMPLETED',
    });
  });

  it('applies schedule, vehicle, and Driver clearing changes with local CAS and no new operation receipt', async () => {
    const tenantId = randomUUID();
    const actorId = randomUUID();
    const tripId = randomUUID();
    const requestId = randomUUID();
    const trip = {
      id: tripId,
      tenantId,
      status: 'DRAFT',
      version: 4n,
      deletedAt: null,
      vehicleId: randomUUID(),
      driverId: randomUUID(),
      driverUserId: randomUUID(),
      driverVersion: 7n,
    };
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const createOperation = vi.fn();
    const pending = vi.fn().mockResolvedValue(null);
    const prisma = {
      tripOperation: {
        findUnique: vi.fn().mockResolvedValue(null),
        findFirst: pending,
      },
      deliveryTrip: { findFirst: vi.fn().mockResolvedValue(trip) },
      $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          deliveryTrip: {
            updateMany,
            findFirst: vi.fn().mockResolvedValue({ version: 5n }),
          },
          tripOperation: { findFirst: pending, create: createOperation },
        }),
      ),
    };
    const queries = {
      get: vi.fn().mockResolvedValue({
        id: tripId,
        tenantId,
        status: 'DRAFT',
        version: 5,
        vehicleId: null,
        driverId: null,
        driverUserId: null,
        driverVersion: null,
      }),
    };
    const masterData = {
      vehicle: vi.fn(),
      lockDriver: vi.fn(),
    };
    const service = new TripCommandService(
      prisma as unknown as PrismaService,
      masterData as unknown as MasterDataClient,
      queries as unknown as TripQueryService,
    );

    const result = await service.update(
      { id: actorId, tenantId } as AuthenticatedUser,
      tripId,
      {
        requestId,
        expectedVersion: 4,
        plannedStartAt: '2026-10-26T08:00:00.000Z',
        vehicleId: null,
        driverId: null,
      },
      '******',
    );

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: tripId,
        tenantId,
        version: 4n,
        status: 'DRAFT',
        deletedAt: null,
      },
      data: expect.objectContaining({
        plannedStartAt: new Date('2026-10-26T08:00:00.000Z'),
        vehicleId: null,
        driverId: null,
        driverUserId: null,
        driverVersion: null,
        version: { increment: 1 },
      }),
    });
    expect(createOperation).not.toHaveBeenCalled();
    expect(pending).toHaveBeenCalledTimes(2);
    expect(masterData.lockDriver).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      version: 5,
      driverId: null,
      vehicleId: null,
    });
  });
});
