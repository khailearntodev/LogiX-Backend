import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '@logix/auth';
import type { PrismaService } from '../database/prisma.service.js';
import { TripConflictError } from '../trips/trip-conflict.error.js';
import { DriverTripService } from './driver-trip.service.js';

const makeUser = (overrides: Partial<AuthenticatedUser> = {}) =>
  ({
    id: randomUUID(),
    tenantId: randomUUID(),
    isSuperAdmin: false,
    ...overrides,
  }) as AuthenticatedUser;

function fixture(stopCount = 1) {
  const tenantId = randomUUID();
  const tripId = randomUUID();
  const driverUserId = randomUUID();
  const driverId = randomUUID();
  const shipmentIds = Array.from({ length: stopCount }, () => randomUUID());
  const stops = shipmentIds.map((shipmentId, index) => ({
    id: randomUUID(),
    tenantId,
    tripId,
    shipmentId,
    deliveryAddressId: randomUUID(),
    addressSnapshot: {
      recipientName: `Recipient ${index + 1}`,
      addressLine: `${index + 1} Test Road`,
    },
    plannedSequence: index + 1,
    approvedSequence: index + 1,
    status: 'PENDING',
    currentAttempt: 0,
    arrivedAt: null,
    completedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    version: 1n,
    deletedAt: null,
  }));
  const trip = {
    id: tripId,
    tenantId,
    tripNumber: 'TR-DRIVER-1',
    warehouseId: randomUUID(),
    vehicleId: randomUUID(),
    driverId,
    driverUserId,
    driverVersion: 1n,
    depotSnapshot: { addressLine: 'Depot' },
    vehicleSnapshot: { plateNumber: 'TEST-1' },
    driverSnapshot: { name: 'Assigned Driver' },
    status: 'IN_PROGRESS',
    plannedStartAt: new Date(),
    actualStartAt: new Date(),
    completedAt: null as Date | null,
    totalWeight: '3',
    totalVolume: '2',
    approvedRoutePlanId: randomUUID(),
    dispatchVersion: 1n,
    dispatchedAt: new Date(),
    canceledAt: null,
    cancelReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    version: 1n,
    deletedAt: null,
    stops,
    shipments: shipmentIds.map((shipmentId) => ({
      shipmentId,
      shipmentSnapshot: { shipmentNumber: `SH-${shipmentId.slice(0, 6)}` },
      assignedAt: new Date(),
      deletedAt: null,
    })),
  };
  const attempts: Array<Record<string, any>> = [];
  const outbox: Array<Record<string, any>> = [];
  const db = {
    deliveryTrip: {
      findFirst: vi.fn(async () => ({
        ...trip,
        stops: stops
          .filter((stop) => stop.status === 'PENDING')
          .sort((a, b) => a.approvedSequence - b.approvedSequence)
          .slice(0, 1),
      })),
      findMany: vi.fn(),
      count: vi.fn(),
      update: vi.fn(async ({ data }: { data: Record<string, any> }) => {
        if (data.status) trip.status = data.status;
        if (data.completedAt) trip.completedAt = data.completedAt;
        trip.version += BigInt(data.version.increment);
        return { ...trip };
      }),
    },
    tripStop: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
        stops.find((stop) => stop.id === where.id) ?? null,
      ),
      count: vi.fn(
        async ({ where }: { where: { id: { not: string } } }) =>
          stops.filter(
            (stop) =>
              stop.status === 'PENDING' && stop.id !== where.id.not,
          ).length,
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, any>;
        }) => {
          const stop = stops.find((entry) => entry.id === where.id)!;
          stop.status = data.status;
          stop.completedAt = data.completedAt;
          stop.version += BigInt(data.version.increment);
          return { ...stop };
        },
      ),
    },
    deliveryAttempt: {
      findFirst: vi.fn(
        async ({ where }: { where: { requestId: string } }) =>
          attempts.find(
            (attempt) =>
              attempt.tenantId === tenantId &&
              attempt.requestId === where.requestId,
          ) ?? null,
      ),
      create: vi.fn(async ({ data }: { data: Record<string, any> }) => {
        attempts.push(data);
        return data;
      }),
    },
    outboxEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, any> }) => {
        outbox.push(data);
        return data;
      }),
    },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(
      async (
        transaction:
          | ((tx: unknown) => Promise<unknown>)
          | Promise<unknown>[],
      ) =>
        typeof transaction === 'function'
          ? transaction(db)
          : Promise.all(transaction),
    ),
  };
  const previewTokens = {
    issue: vi.fn(() => ({
      previewToken: 'signed-preview',
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    })),
    verify: vi.fn(),
  };
  return {
    tenantId,
    tripId,
    driverUserId,
    driverId,
    stops,
    trip,
    attempts,
    outbox,
    db,
    previews: previewTokens,
    service: new DriverTripService(
      db as unknown as PrismaService,
      previewTokens as never,
    ),
  };
}

describe('Driver trip API domain', () => {
  it('scopes the current-trip list to the authenticated assigned Driver', async () => {
    const f = fixture();
    const user = makeUser({ id: f.driverUserId, tenantId: f.tenantId });
    f.db.deliveryTrip.findMany.mockResolvedValue([
      {
        ...f.trip,
        stops: f.stops,
      },
    ]);
    f.db.deliveryTrip.count.mockResolvedValue(1);

    const result = await f.service.list(user, {
      scope: 'current',
      page: 1,
      pageSize: 20,
    });

    expect(f.db.deliveryTrip.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: f.tenantId,
          driverUserId: user.id,
          status: { in: ['IN_PROGRESS'] },
        }),
      }),
    );
    expect(result.items[0]).toMatchObject({
      tripId: f.tripId,
      status: 'IN_PROGRESS',
      nextStopId: f.stops[0].id,
    });
  });

  it('denies a Driver-supplied driver filter and hides another Driver trip detail', async () => {
    const f = fixture();
    const user = makeUser({ id: randomUUID(), tenantId: f.tenantId });

    await expect(
      f.service.list(user, {
        scope: 'history',
        driverId: f.driverId,
        page: 1,
        pageSize: 20,
      }),
    ).rejects.toThrow();
    await expect(f.service.detail(user, f.tripId)).rejects.toThrow();
  });

  it('allows Super Admin detail without a Driver profile but tenant-scopes the lookup', async () => {
    const f = fixture();
    const user = makeUser({
      tenantId: f.tenantId,
      isSuperAdmin: true,
    });

    const result = await f.service.detail(user, f.tripId);

    expect(f.db.deliveryTrip.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: f.tripId, tenantId: f.tenantId, deletedAt: null },
      }),
    );
    expect(result.stops[0]).toMatchObject({
      stopId: f.stops[0].id,
      shipmentNumber: expect.stringMatching(/^SH-/),
      isNext: true,
    });
  });

  it('rejects a later stop and records only the final stop result as one immutable receipt and outbox event', async () => {
    const f = fixture(2);
    const user = makeUser({ id: f.driverUserId, tenantId: f.tenantId });
    const requestId = randomUUID();
    const command = {
      requestId,
      expectedTripVersion: 1,
      expectedStopVersion: 1,
      confirmed: true as const,
    };

    await expect(
      f.service.deliver(user, f.tripId, f.stops[1].id, command),
    ).rejects.toThrow(TripConflictError);
    expect(f.db.deliveryAttempt.create).not.toHaveBeenCalled();

    const receipt = await f.service.deliver(
      user,
      f.tripId,
      f.stops[0].id,
      command,
    );

    expect(receipt).toMatchObject({
      requestId,
      tripId: f.tripId,
      tripStopId: f.stops[0].id,
      shipmentId: f.stops[0].shipmentId,
      driverId: f.driverId,
      assigneeUserId: f.driverUserId,
      actorUserId: user.id,
      actorMode: 'DRIVER',
      status: 'DELIVERED',
      attempt: 1,
      tripVersion: 2,
      stopVersion: 2,
    });
    expect(f.trip.status).toBe('IN_PROGRESS');
    expect(f.db.deliveryAttempt.create).toHaveBeenCalledTimes(1);
    expect(f.outbox[0]).toMatchObject({
      eventType: 'DeliveryCompleted',
      eventVersion: 2,
      aggregateType: 'DeliveryTrip',
      aggregateId: f.tripId,
      payload: {
        contractVersion: 1,
        tenantId: f.tenantId,
        tripId: f.tripId,
        stopId: f.stops[0].id,
        shipmentId: f.stops[0].shipmentId,
        driverId: f.driverId,
        assigneeUserId: f.driverUserId,
        outcome: 'DELIVERED',
        requestId,
        reason: null,
      },
    });
  });

  it('completes the trip when its last stop is terminal and exact request replay returns the stored receipt', async () => {
    const f = fixture();
    const user = makeUser({ id: f.driverUserId, tenantId: f.tenantId });
    const command = {
      requestId: randomUUID(),
      expectedTripVersion: 1,
      expectedStopVersion: 1,
      confirmed: true as const,
    };

    const first = await f.service.deliver(
      user,
      f.tripId,
      f.stops[0].id,
      command,
    );
    const replay = await f.service.deliver(
      user,
      f.tripId,
      f.stops[0].id,
      command,
    );

    expect(f.trip.status).toBe('COMPLETED');
    expect(f.trip.completedAt).toBeInstanceOf(Date);
    expect(f.db.deliveryAttempt.create).toHaveBeenCalledTimes(1);
    expect(f.db.outboxEvent.create).toHaveBeenCalledTimes(1);
    expect(replay).toEqual(first);
  });

  it('rejects a reused request ID with changed payload and requires admin preview binding', async () => {
    const f = fixture();
    const user = makeUser({ id: f.driverUserId, tenantId: f.tenantId });
    const command = {
      requestId: randomUUID(),
      expectedTripVersion: 1,
      expectedStopVersion: 1,
      confirmed: true as const,
      reason: 'Incorrect address',
    };
    await f.service.fail(user, f.tripId, f.stops[0].id, command);
    await expect(
      f.service.fail(user, f.tripId, f.stops[0].id, {
        ...command,
        reason: 'Recipient unavailable',
      }),
    ).rejects.toThrow(TripConflictError);

    const admin = makeUser({
      tenantId: f.tenantId,
      isSuperAdmin: true,
    });
    await expect(
      f.service.deliver(admin, f.tripId, f.stops[0].id, {
        requestId: randomUUID(),
        expectedTripVersion: 1,
        expectedStopVersion: 1,
        confirmed: true,
      }),
    ).rejects.toThrow();
  });

  it('rejects a success command that carries a failure reason', async () => {
    const f = fixture();
    const user = makeUser({ id: f.driverUserId, tenantId: f.tenantId });

    await expect(
      f.service.deliver(user, f.tripId, f.stops[0].id, {
        requestId: randomUUID(),
        expectedTripVersion: 1,
        expectedStopVersion: 1,
        confirmed: true,
        reason: 'Must be a failure reason only',
      }),
    ).rejects.toThrow();
  });

  it('binds Super Admin preview to the authenticated actor and actual assignee', async () => {
    const f = fixture();
    const admin = makeUser({
      tenantId: f.tenantId,
      isSuperAdmin: true,
    });

    const preview = await f.service.preview(admin, f.tripId, f.stops[0].id, {
      action: 'FAIL',
      expectedTripVersion: 1,
      expectedStopVersion: 1,
      actingReason: 'Supervisory correction',
      reason: 'Recipient unavailable',
    });

    expect(preview).toMatchObject({
      tripId: f.tripId,
      stopId: f.stops[0].id,
      assignedDriverId: f.driverId,
      statusBefore: 'PENDING',
      statusAfter: 'FAILED',
      previewToken: 'signed-preview',
    });
    expect(f.previews.issue).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: f.tenantId,
        actorId: admin.id,
        tripId: f.tripId,
      }),
    );
  });
});
