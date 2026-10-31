import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '@logix/auth';
import type { PrismaService } from '../database/prisma.service.js';
import type { FulfillmentClient } from '../integrations/fulfillment.client.js';
import { DownstreamError } from '../integrations/downstream-error.js';
import { TripMembershipService } from './trip-membership.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type { TripQueryService } from './trip-query.service.js';

describe('Durable trip membership intents', () => {
  it('atomically stores a successful invalid-snapshot claim and its compensating release before clearing membership', async () => {
    const tenantId = randomUUID();
    const tripId = randomUUID();
    const actorId = randomUUID();
    const operationId = randomUUID();
    const membership = {
      id: randomUUID(),
      tenantId,
      tripId,
      shipmentId: randomUUID(),
      state: 'CLAIM_PENDING',
      shipmentVersion: null,
      claimReceipt: null,
    } as Record<string, any>;
    const receipt = { claimId: randomUUID(), shipmentVersion: 4 };
    const update = vi.fn(async ({ data }: { data: Record<string, any> }) => {
      Object.assign(membership, data);
      return membership;
    });
    const operationUpdate = vi.fn();
    const tx = {
      tripOperation: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({ id: operationId, tripId, actorId }),
        update: operationUpdate,
      },
      deliveryTrip: { findUniqueOrThrow: vi.fn().mockResolvedValue({ version: 3n }) },
      tripShipment: {
        update,
        findMany: vi.fn(async () => [membership]),
      },
    };
    const service = new TripMembershipService(
      {
        $transaction: vi.fn(async (callback: (client: unknown) => Promise<unknown>) =>
          callback(tx),
        ),
      } as unknown as PrismaService,
      {} as FulfillmentClient,
      {} as TripQueryService,
    );

    await (service as any).beginCompensation(operationId, 'missing coordinates', {
      membershipId: membership.id,
      receipt,
    });

    expect(membership.state).toBe('RELEASE_PENDING');
    expect(membership.removedAt).toBeUndefined();
    expect(membership.claimReceipt).toEqual(receipt);
    expect(membership.releaseRequest).toMatchObject({
      tenantId, tripId, actorId,
      claimId: receipt.claimId,
      expectedTripVersion: 3,
      expectedShipmentVersion: 4,
      reason: 'BATCH_ADD_COMPENSATION',
    });
    expect(operationUpdate).toHaveBeenCalledWith({
      where: { id: operationId },
      data: { status: 'COMPENSATING', lastError: 'missing coordinates' },
    });
  });

  it('maps an active shipment uniqueness race to a domain conflict', async () => {
    const prisma = {
      tripOperation: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn().mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('unique conflict', {
          code: 'P2002',
          clientVersion: '7.10.0',
          meta: { target: 'ux_trip_active_shipment' },
        }),
      ),
    } as unknown as PrismaService;
    const service = new TripMembershipService(
      prisma,
      {} as FulfillmentClient,
      {} as TripQueryService,
    );
    await expect(service.add(
      { id: randomUUID(), tenantId: randomUUID() } as AuthenticatedUser,
      randomUUID(),
      {
        requestId: randomUUID(),
        expectedTripVersion: 1,
        shipments: [{ shipmentId: randomUUID(), expectedShipmentVersion: 1 }],
      },
    )).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION', httpStatus: 409 });
  });

  it.each([
    [null, null],
    [null, '105.000000'],
    ['91.000000', '105.000000'],
    ['21.000000', 'invalid'],
  ])('rejects missing or invalid claim coordinates (%s,%s) definitively', async (latitude, longitude) => {
    const tenantId = randomUUID();
    const shipmentId = randomUUID();
    const warehouseId = randomUUID();
    const transaction = vi.fn();
    const service = new TripMembershipService(
      {
        tripShipment: {
          findUniqueOrThrow: vi.fn().mockResolvedValue({
            tenantId, shipmentId, warehouseId, tripId: randomUUID(),
          }),
        },
        $transaction: transaction,
      } as unknown as PrismaService,
      {} as FulfillmentClient,
      {} as TripQueryService,
    );
    await expect((service as any).persistClaim(randomUUID(), {
      receipt: {},
      snapshot: {
        tenantId,
        shipmentId,
        warehouseId,
        deliveryAddressSnapshot: { addressId: randomUUID(), latitude, longitude },
        totalWeight: '1.000',
        totalVolume: '1.000000',
      },
    })).rejects.toMatchObject({ definite: true });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('persists the exact child claim before HTTP and keeps unknown outcomes pending for replay', async () => {
    const tenantId = randomUUID();
    const actorId = randomUUID();
    const tripId = randomUUID();
    const requestId = randomUUID();
    const shipmentId = randomUUID();
    const operationId = randomUUID();
    const trip = {
      id: tripId,
      tenantId,
      version: 3n,
      status: 'DRAFT',
      warehouseId: randomUUID(),
      deletedAt: null,
    };
    const membershipRows: Array<Record<string, any>> = [];
    let operation: Record<string, any> = {
      id: operationId,
      tenantId,
      tripId,
      requestId,
      actorId,
      kind: 'ADD',
      status: 'PENDING',
      payloadHash: '',
      payload: {},
      result: null,
      activeLock: `${tenantId}:${tripId}`,
      attemptCount: 0,
      lastError: null,
    };
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      deliveryTrip: {
        findFirst: vi.fn().mockResolvedValue(trip),
        update: vi.fn().mockResolvedValue({ ...trip, version: 4n }),
      },
      tripOperation: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn(async ({ data }: { data: Record<string, any> }) => {
          operation = { ...operation, ...data };
          return operation;
        }),
      },
      tripShipment: {
        findMany: vi.fn(async ({ where }: { where: Record<string, any> }) => {
          if (where.state === 'CLAIM_PENDING') {
            return membershipRows.filter((row) => row.state === 'CLAIM_PENDING');
          }
          if (where.id?.in) {
            return membershipRows.filter((row) => where.id.in.includes(row.id));
          }
          return membershipRows;
        }),
        createMany: vi.fn(async ({ data }: { data: Array<Record<string, any>> }) => {
          membershipRows.push(
            ...data.map((row) => ({
              ...row,
              assignedAt: new Date(),
              claimReceipt: null,
              shipmentSnapshot: null,
            })),
          );
          return { count: data.length };
        }),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
        callback(tx),
      ),
      tripOperation: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn(async ({ where }: { where: Record<string, any> }) => {
          if (where.tenantId_requestId) return null;
          return operation.id === where.id ? operation : null;
        }),
        findUniqueOrThrow: vi.fn(async () => operation),
        findFirst: vi.fn(async ({ where }: { where: Record<string, any> }) =>
          where.tenantId === operation.tenantId &&
          where.requestId === operation.requestId ? operation : null,
        ),
        update: vi.fn(async ({ data }: { data: Record<string, any> }) => {
          operation = { ...operation, ...data };
          return operation;
        }),
      },
      tripShipment: {
        findMany: tx.tripShipment.findMany,
      },
      deliveryTrip: {
        findFirst: vi.fn().mockResolvedValue(trip),
      },
    };
    const claim = vi.fn().mockRejectedValue(
      new DownstreamError('request timed out after send', null, false),
    );
    const service = new TripMembershipService(
      prisma as unknown as PrismaService,
      { claim } as unknown as FulfillmentClient,
      { get: vi.fn() } as unknown as TripQueryService,
    );

    const result = await service.add(
      { id: actorId, tenantId } as AuthenticatedUser,
      tripId,
      {
        requestId,
        expectedTripVersion: 3,
        shipments: [{ shipmentId, expectedShipmentVersion: 8 }],
      },
    );

    expect(tx.tripShipment.createMany).toHaveBeenCalledTimes(1);
    expect(membershipRows).toHaveLength(1);
    const storedClaim = membershipRows[0].claimRequest;
    expect(storedClaim).toMatchObject({
      contractVersion: 1,
      tenantId,
      requestId: expect.any(String),
      tripId,
      shipmentId,
      actorId,
      expectedTripVersion: 4,
      expectedShipmentVersion: 8,
    });
    expect(claim).toHaveBeenCalledExactlyOnceWith(storedClaim);
    expect(result).toMatchObject({
      tripId,
      requestId,
      kind: 'ADD',
      status: 'PENDING',
      results: [{ shipmentId, state: 'CLAIM_PENDING' }],
    });
    expect(operation.attemptCount).toBe(1);
    expect(operation.lastError).toContain('timed out');
  });

  it('rejects the same requestId with a different actor or payload before rechecking stale trip version', async () => {
    const tenantId = randomUUID();
    const actorId = randomUUID();
    const requestId = randomUUID();
    const tripId = randomUUID();
    const shipmentId = randomUUID();
    const previousOperation = {
      id: randomUUID(),
      tenantId,
      tripId,
      requestId,
      actorId,
      kind: 'ADD',
      status: 'COMPLETED',
      payloadHash: 'different-hash',
      payload: {},
      result: {},
    };
    const findFirstTrip = vi.fn();
    const prisma = {
      tripOperation: {
        findUnique: vi.fn().mockResolvedValue(previousOperation),
      },
      deliveryTrip: { findFirst: findFirstTrip },
    } as unknown as PrismaService;
    const service = new TripMembershipService(
      prisma,
      {} as FulfillmentClient,
      {} as TripQueryService,
    );

    await expect(service.add(
      { id: actorId, tenantId } as AuthenticatedUser,
      tripId,
      {
        requestId,
        expectedTripVersion: 1,
        shipments: [{ shipmentId, expectedShipmentVersion: 1 }],
      },
    )).rejects.toMatchObject({
      code: 'BUSINESS_RULE_VIOLATION',
      details: { requestId },
    });
    expect(findFirstTrip).not.toHaveBeenCalled();
  });
});
