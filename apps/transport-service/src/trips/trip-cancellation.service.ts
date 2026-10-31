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
  type ShipmentReleaseRequest,
} from '@logix/messaging';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../database/prisma.service.js';
import type { CancelTripDto } from './trip.dto.js';
import { stableHash, toSafeVersion } from './trip-serialization.js';
import { TripMembershipService } from './trip-membership.service.js';
import { TripConflictError } from './trip-conflict.error.js';
import { TripCancelPreviewTokenService } from './trip-cancel-preview-token.service.js';
import { assertNoPending, lockTrip } from '../routes/route-domain.js';

@Injectable()
export class TripCancellationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly memberships: TripMembershipService,
    private readonly previewTokens: TripCancelPreviewTokenService,
  ) {}

  async preview(
    user: AuthenticatedUser,
    tripId: string,
    expectedVersion: number,
  ) {
    const trip = await this.prisma.deliveryTrip.findFirst({
      where: { id: tripId, tenantId: user.tenantId, deletedAt: null },
    });
    if (!trip) throw new EntityNotFoundError('DeliveryTrip', tripId);
    this.assertVersion(tripId, expectedVersion, trip.version);
    if (trip.status !== 'DRAFT' && trip.status !== 'APPROVED') {
      throw new InvalidStateTransitionError(
        'DeliveryTrip',
        trip.status,
        'CANCEL',
      );
    }
    const operation = await this.prisma.tripOperation.findFirst({
      where: { activeLock: `${user.tenantId}:${tripId}` },
      select: { requestId: true },
    });
    const dispatch = await this.prisma.tripDispatch.findFirst({
      where: { tenantId: user.tenantId, tripId, status: { not: 'REJECTED' } },
    });
    const active = await this.prisma.tripShipment.findMany({
      where: {
        tenantId: user.tenantId,
        tripId,
        state: 'ACTIVE',
        removedAt: null,
      },
      select: {
        id: true,
        shipmentId: true,
        version: true,
        shipmentVersion: true,
      },
      orderBy: { shipmentId: 'asc' },
    });
    const membershipHash = stableHash({
      tenantId: user.tenantId,
      actorId: user.id,
      tripId,
      expectedVersion,
      memberships: active.map((membership) => ({
        id: membership.id,
        shipmentId: membership.shipmentId,
        version: membership.version.toString(),
        shipmentVersion: membership.shipmentVersion?.toString() ?? null,
      })),
    });
    const { token, expiresAt } = this.previewTokens.issue({
      tenantId: user.tenantId,
      actorId: user.id,
      tripId,
      expectedVersion,
      membershipHash,
    });
    return {
      previewToken: token,
      tripId,
      expectedVersion,
      expiresAt,
      activeShipmentCount: active.length,
      releaseCount: active.length,
      blockers: operation || dispatch ? ['TRIP_OPERATION_PENDING'] : [],
      ...(operation ? { pendingRequestId: operation.requestId } : {}),
    };
  }

  async cancel(user: AuthenticatedUser, tripId: string, dto: CancelTripDto) {
    const hash = stableHash({ kind: 'CANCEL', tripId, ...dto });
    const legacyPreview = 'previewId' in dto;
    const replay = await this.findReplay(
      user.tenantId,
      tripId,
      user.id,
      dto.requestId,
      hash,
    );
    if (replay) return this.replayOperation(user.tenantId, replay);
    if (legacyPreview) {
      throw new BusinessRuleViolationError('CANCEL_PREVIEW_REFRESH_REQUIRED', {
        code: 'CANCEL_PREVIEW_REFRESH_REQUIRED',
        requestId: dto.requestId,
        action: 'refreshPreview',
      });
    }
    const claims = this.previewTokens.verify(dto.previewToken);
    if (
      claims.tenantId !== user.tenantId ||
      claims.actorId !== user.id ||
      claims.tripId !== tripId ||
      claims.expectedVersion !== dto.expectedVersion
    ) {
      throw new BusinessRuleViolationError(
        'CANCEL_PREVIEW_EXPIRED_OR_INVALID',
        {
          action: 'refreshPreview',
        },
      );
    }

    const operationId = randomUUID();
    try {
      await this.prisma.$transaction(async (tx) => {
        await lockTrip(tx, user.tenantId, tripId);
        await assertNoPending(tx, user.tenantId, tripId);
        const trip = await tx.deliveryTrip.findFirst({
          where: { id: tripId, tenantId: user.tenantId, deletedAt: null },
        });
        if (!trip) throw new EntityNotFoundError('DeliveryTrip', tripId);
        this.assertVersion(tripId, dto.expectedVersion, trip.version);
        if (trip.status !== 'DRAFT' && trip.status !== 'APPROVED') {
          throw new InvalidStateTransitionError(
            'DeliveryTrip',
            trip.status,
            'CANCEL',
          );
        }
        if (trip.version >= BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new ConcurrencyConflictError(
            'DeliveryTrip',
            tripId,
            dto.expectedVersion,
            toSafeVersion(trip.version),
          );
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
        const rows = await tx.tripShipment.findMany({
          where: {
            tenantId: user.tenantId,
            tripId,
            state: 'ACTIVE',
            removedAt: null,
          },
          orderBy: { shipmentId: 'asc' },
        });
        const currentMembershipHash = stableHash({
          tenantId: user.tenantId,
          actorId: user.id,
          tripId,
          expectedVersion: dto.expectedVersion,
          memberships: rows.map((membership) => ({
            id: membership.id,
            shipmentId: membership.shipmentId,
            version: membership.version.toString(),
            shipmentVersion: membership.shipmentVersion?.toString() ?? null,
          })),
        });
        if (currentMembershipHash !== claims.membershipHash) {
          throw new BusinessRuleViolationError('CANCEL_PREVIEW_STALE', {
            action: 'refreshPreview',
          });
        }
        const membershipIds = rows.map(({ id }) => id);
        await tx.tripOperation.create({
          data: {
            id: operationId,
            tenantId: user.tenantId,
            tripId,
            requestId: dto.requestId,
            actorId: user.id,
            kind: 'CANCEL',
            status: 'PENDING',
            payloadHash: hash,
            payload: {
              request:
                'previewToken' in dto
                  ? {
                      requestId: dto.requestId,
                      expectedVersion: dto.expectedVersion,
                      confirmed: dto.confirmed,
                      reason: dto.reason,
                      previewTokenHash: stableHash(dto.previewToken),
                    }
                  : dto,
              shipmentIds: rows.map(({ shipmentId }) => shipmentId),
              membershipIds,
              reason: dto.reason,
            },
            activeLock: `${user.tenantId}:${tripId}`,
          },
        });
        for (const membership of rows) {
          const claim = membership.claimReceipt as {
            claimId?: unknown;
            tripVersion?: unknown;
          } | null;
          if (
            !claim ||
            typeof claim.claimId !== 'string' ||
            typeof claim.tripVersion !== 'number' ||
            membership.shipmentVersion === null
          ) {
            throw new BusinessRuleViolationError(
              'MEMBERSHIP_CLAIM_RECEIPT_MISSING',
              {
                shipmentId: membership.shipmentId,
              },
            );
          }
          const release: ShipmentReleaseRequest = {
            contractVersion: TRANSPORT_CONTRACT_VERSION,
            tenantId: user.tenantId,
            requestId: randomUUID(),
            claimId: claim.claimId,
            tripId,
            shipmentId: membership.shipmentId,
            actorId: user.id,
            expectedTripVersion: toSafeVersion(trip.version + 1n),
            expectedShipmentVersion: toSafeVersion(membership.shipmentVersion),
            reason: 'TRIP_CANCELED',
          };
          await tx.tripShipment.update({
            where: { id: membership.id },
            data: {
              operationId,
              state: 'RELEASE_PENDING',
              releaseRequest: release as unknown as Prisma.InputJsonValue,
            },
          });
        }
        await tx.deliveryTrip.update({
          where: { id: tripId },
          data: { version: { increment: 1 } },
        });
      });
    } catch (error) {
      const raced = await this.findReplay(
        user.tenantId,
        tripId,
        user.id,
        dto.requestId,
        hash,
      );
      if (!raced) throw error;
      return this.replayOperation(user.tenantId, raced);
    }
    await this.memberships.resume(operationId, true);
    return this.memberships.operationView(user.tenantId, dto.requestId);
  }

  private async findReplay(
    tenantId: string,
    tripId: string,
    actorId: string,
    requestId: string,
    payloadHash: string,
  ) {
    const operation = await this.prisma.tripOperation.findUnique({
      where: { tenantId_requestId: { tenantId, requestId } },
    });
    if (!operation) return null;
    if (
      operation.kind !== 'CANCEL' ||
      operation.tripId !== tripId ||
      operation.actorId !== actorId ||
      operation.payloadHash !== payloadHash
    ) {
      throw new TripConflictError('REQUEST_ID_REPLAY_MISMATCH', { requestId });
    }
    return operation;
  }

  private async replayOperation(
    tenantId: string,
    operation: { id: string; requestId: string },
  ) {
    await this.memberships.resume(operation.id, true);
    return this.memberships.operationView(tenantId, operation.requestId);
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
