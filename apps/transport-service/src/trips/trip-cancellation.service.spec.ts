import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '@logix/auth';
import type { PrismaService } from '../database/prisma.service.js';
import { TripCancellationService } from './trip-cancellation.service.js';
import { stableHash } from './trip-serialization.js';
import type { TripMembershipService } from './trip-membership.service.js';
import type { TripCancelPreviewTokenService } from './trip-cancel-preview-token.service.js';

describe('Draft trip cancellation', () => {
  it('issues a five-minute signed token bound to actor, version, and membership history', async () => {
    const tenantId = randomUUID();
    const actorId = randomUUID();
    const tripId = randomUUID();
    const shipmentId = randomUUID();
    const membershipId = randomUUID();
    const expiresAt = new Date(Date.now() + 300_000);
    const issue = vi
      .fn()
      .mockReturnValue({ token: 'signed-preview', expiresAt });
    const service = new TripCancellationService(
      {
        deliveryTrip: {
          findFirst: vi.fn().mockResolvedValue({
            id: tripId,
            tenantId,
            status: 'DRAFT',
            version: 6n,
          }),
        },
        tripOperation: { findFirst: vi.fn().mockResolvedValue(null) },
        tripDispatch: { findFirst: vi.fn().mockResolvedValue(null) },
        tripShipment: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: membershipId,
              shipmentId,
              version: 3n,
              shipmentVersion: 19n,
            },
          ]),
        },
      } as unknown as PrismaService,
      {} as TripMembershipService,
      { issue } as unknown as TripCancelPreviewTokenService,
    );

    const result = await service.preview(
      { id: actorId, tenantId } as AuthenticatedUser,
      tripId,
      6,
    );

    expect(issue).toHaveBeenCalledWith({
      tenantId,
      actorId,
      tripId,
      expectedVersion: 6,
      membershipHash: stableHash({
        tenantId,
        actorId,
        tripId,
        expectedVersion: 6,
        memberships: [
          {
            id: membershipId,
            shipmentId,
            version: '3',
            shipmentVersion: '19',
          },
        ],
      }),
    });
    expect(result).toMatchObject({
      previewToken: 'signed-preview',
      tripId,
      expectedVersion: 6,
      expiresAt,
      activeShipmentCount: 1,
      releaseCount: 1,
      blockers: [],
    });
  });

  it('rejects a legacy preview ID without an exact stored cancellation receipt', async () => {
    const tenantId = randomUUID();
    const actorId = randomUUID();
    const tripId = randomUUID();
    const requestId = randomUUID();
    const tokens = { verify: vi.fn() };
    const prisma = {
      tripOperation: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    const service = new TripCancellationService(
      prisma,
      {} as TripMembershipService,
      tokens as unknown as TripCancelPreviewTokenService,
    );

    await expect(
      service.cancel({ id: actorId, tenantId } as AuthenticatedUser, tripId, {
        requestId,
        expectedVersion: 9,
        previewId: randomUUID(),
        confirmed: true,
        reason: 'Changed delivery schedule',
      }),
    ).rejects.toMatchObject({
      code: 'BUSINESS_RULE_VIOLATION',
      details: {
        code: 'CANCEL_PREVIEW_REFRESH_REQUIRED',
        action: 'refreshPreview',
      },
    });
    expect(tokens.verify).not.toHaveBeenCalled();
    expect(prisma.tripOperation.findUnique).toHaveBeenCalledOnce();
  });

  it('rejects a token bound to another actor before opening the cancel transaction', async () => {
    const tenantId = randomUUID();
    const actorId = randomUUID();
    const tripId = randomUUID();
    const tokens = {
      verify: vi.fn().mockReturnValue({
        tenantId,
        actorId: randomUUID(),
        tripId,
        expectedVersion: 2,
        membershipHash: randomUUID(),
      }),
    };
    const transaction = vi.fn();
    const service = new TripCancellationService(
      {
        tripOperation: { findUnique: vi.fn().mockResolvedValue(null) },
        $transaction: transaction,
      } as unknown as PrismaService,
      {} as TripMembershipService,
      tokens as unknown as TripCancelPreviewTokenService,
    );

    await expect(
      service.cancel({ id: actorId, tenantId } as AuthenticatedUser, tripId, {
        requestId: randomUUID(),
        expectedVersion: 2,
        previewToken: 'signed-for-other-actor',
        confirmed: true,
        reason: 'Changed delivery schedule',
      }),
    ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('replays an exact legacy receipt before any preview validation', async () => {
    const tenantId = randomUUID();
    const actorId = randomUUID();
    const tripId = randomUUID();
    const requestId = randomUUID();
    const previewId = randomUUID();
    const dto = {
      requestId,
      expectedVersion: 9,
      previewId,
      confirmed: true as const,
      reason: 'Changed delivery schedule',
    };
    const operation = {
      id: randomUUID(),
      tripId,
      requestId,
      actorId,
      kind: 'CANCEL',
      payloadHash: stableHash({ kind: 'CANCEL', tripId, ...dto }),
    };
    const result = {
      tripId,
      requestId,
      kind: 'CANCEL',
      status: 'COMPLETED',
      version: 10,
      results: [],
    };
    const resume = vi.fn();
    const operationView = vi.fn().mockResolvedValue(result);
    const tokens = { verify: vi.fn() };
    const service = new TripCancellationService(
      {
        tripOperation: {
          findUnique: vi.fn().mockResolvedValue(operation),
        },
      } as unknown as PrismaService,
      { resume, operationView } as unknown as TripMembershipService,
      tokens as unknown as TripCancelPreviewTokenService,
    );

    await expect(
      service.cancel(
        { id: actorId, tenantId } as AuthenticatedUser,
        tripId,
        dto,
      ),
    ).resolves.toEqual(result);
    expect(resume).toHaveBeenCalledWith(operation.id, true);
    expect(operationView).toHaveBeenCalledWith(tenantId, requestId);
    expect(tokens.verify).not.toHaveBeenCalled();
  });

  it('commits a validated token-bound cancel intent before resuming release recovery', async () => {
    const tenantId = randomUUID();
    const actorId = randomUUID();
    const tripId = randomUUID();
    const requestId = randomUUID();
    const token = 'signed-preview';
    const shipmentId = randomUUID();
    const membershipId = randomUUID();
    const trip = {
      id: tripId,
      tenantId,
      status: 'DRAFT',
      version: 9n,
      deletedAt: null,
    };
    const membership = {
      id: membershipId,
      tenantId,
      tripId,
      shipmentId,
      version: 4n,
      shipmentVersion: 11n,
      claimReceipt: { claimId: randomUUID(), tripVersion: 50 },
    };
    const dto = {
      requestId,
      expectedVersion: 9,
      previewToken: token,
      confirmed: true as const,
      reason: 'Changed delivery schedule',
    };
    const membershipHash = stableHash({
      tenantId,
      actorId,
      tripId,
      expectedVersion: 9,
      memberships: [
        {
          id: membershipId,
          shipmentId,
          version: '4',
          shipmentVersion: '11',
        },
      ],
    });
    const createOperation = vi.fn().mockResolvedValue({});
    const updateMembership = vi.fn().mockResolvedValue({});
    let transactionFinished = false;
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      tripDispatch: { findFirst: vi.fn().mockResolvedValue(null) },
      deliveryTrip: {
        findFirst: vi.fn().mockResolvedValue(trip),
        update: vi.fn().mockResolvedValue({}),
      },
      tripOperation: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: createOperation,
      },
      tripShipment: {
        findMany: vi.fn().mockResolvedValue([membership]),
        update: updateMembership,
      },
    };
    const prisma = {
      $transaction: vi.fn(
        async (callback: (tx: unknown) => Promise<unknown>) => {
          const result = await callback(tx);
          transactionFinished = true;
          return result;
        },
      ),
      tripOperation: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    const operationResult = {
      tripId,
      requestId,
      kind: 'CANCEL',
      status: 'PENDING',
      version: 10,
      results: [{ shipmentId, state: 'RELEASE_PENDING' }],
    };
    const resume = vi.fn(async () => {
      expect(transactionFinished).toBe(true);
    });
    const operationView = vi.fn().mockResolvedValue(operationResult);
    const tokens = {
      verify: vi.fn().mockReturnValue({
        tenantId,
        actorId,
        tripId,
        expectedVersion: 9,
        membershipHash,
      }),
    };
    const service = new TripCancellationService(
      prisma,
      { resume, operationView } as unknown as TripMembershipService,
      tokens as unknown as TripCancelPreviewTokenService,
    );

    await expect(
      service.cancel(
        { id: actorId, tenantId } as AuthenticatedUser,
        tripId,
        dto,
      ),
    ).resolves.toEqual(operationResult);
    expect(createOperation).toHaveBeenCalledWith({
      data: expect.objectContaining({
        requestId,
        actorId,
        kind: 'CANCEL',
        status: 'PENDING',
        payloadHash: stableHash({ kind: 'CANCEL', tripId, ...dto }),
        payload: expect.objectContaining({
          request: expect.objectContaining({
            previewTokenHash: stableHash(token),
          }),
        }),
        activeLock: `${tenantId}:${tripId}`,
      }),
    });
    expect(updateMembership).toHaveBeenCalledWith({
      where: { id: membershipId },
      data: expect.objectContaining({
        state: 'RELEASE_PENDING',
        operationId: expect.any(String),
        releaseRequest: expect.objectContaining({
          tenantId,
          tripId,
          shipmentId,
          actorId,
          expectedTripVersion: 10,
          expectedShipmentVersion: 11,
          claimId: membership.claimReceipt.claimId,
          reason: 'TRIP_CANCELED',
        }),
      }),
    });
    expect(JSON.stringify(createOperation.mock.calls[0])).not.toContain(token);
    expect(resume).toHaveBeenCalledOnce();
  });
});
