import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  shipmentLifecycleSchema,
  validateShipmentEnvelope,
  type DomainEventEnvelope,
} from '@logix/messaging';
import { ServiceId } from '@logix/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../database/prisma.service.js';
import { TripMembershipService } from './trip-membership.service.js';
import { toSafeVersion } from './trip-serialization.js';
import { TRANSPORT_CONTRACT_VERSION, type ShipmentReleaseRequest } from '@logix/messaging';
import { assertNoPending, lockTrip } from '../routes/route-domain.js';

const CONSUMER_NAME = 'transport-shipment-canceled-v1';

@Injectable()
export class ShipmentCanceledConsumer {
  constructor(
    private readonly prisma: PrismaService,
    private readonly memberships: TripMembershipService,
  ) {}

  async handle(event: DomainEventEnvelope): Promise<void> {
    if (event.eventType !== 'ShipmentCanceled') return;
    validateShipmentEnvelope(event, ServiceId.FULFILLMENT_SERVICE, 'Shipment');
    const payload = shipmentLifecycleSchema.parse(event.payload);
    if (payload.shipmentId !== event.aggregateId) {
      throw new Error('ShipmentCanceled aggregate identity does not match its payload');
    }

    const duplicate = await this.prisma.inboxEvent.findUnique({
      where: {
        consumerName_eventId: {
          consumerName: CONSUMER_NAME,
          eventId: event.eventId,
        },
      },
      select: { id: true },
    });
    if (duplicate) return;

    let operationId: string | null = null;
    await this.prisma.$transaction(async (tx) => {
      const previous = await tx.inboxEvent.findFirst({
        where: {
          consumerName: CONSUMER_NAME,
          tenantId: event.tenantId,
          aggregateId: event.aggregateId,
          aggregateVersion: { not: null },
        },
        orderBy: { aggregateVersion: 'desc' },
        select: { aggregateVersion: true },
      });
      if (
        previous?.aggregateVersion !== null &&
        previous?.aggregateVersion !== undefined &&
        previous.aggregateVersion >= BigInt(event.aggregateVersion)
      ) {
        await tx.inboxEvent.create({
          data: {
            tenantId: event.tenantId,
            eventId: event.eventId,
            consumerName: CONSUMER_NAME,
            eventType: event.eventType,
            aggregateId: event.aggregateId,
            aggregateVersion: BigInt(event.aggregateVersion),
            outcome: 'IGNORED_STALE',
          },
        });
        return;
      }

      const membership = await tx.tripShipment.findFirst({
        where: {
          tenantId: event.tenantId,
          shipmentId: payload.shipmentId,
          removedAt: null,
          state: { in: ['CLAIM_PENDING', 'ACTIVE', 'RELEASE_PENDING'] },
        },
      });
      if (membership && membership.state !== 'ACTIVE') {
        throw new Error(
          `ShipmentCanceled is waiting for membership state ${membership.state}`,
        );
      }
      if (!membership) {
        await tx.inboxEvent.create({
          data: {
            tenantId: event.tenantId,
            eventId: event.eventId,
            consumerName: CONSUMER_NAME,
            eventType: event.eventType,
            aggregateId: event.aggregateId,
            aggregateVersion: BigInt(event.aggregateVersion),
            outcome: membership ? 'IGNORED_PENDING_CLAIM' : 'NO_MEMBERSHIP',
          },
        });
        return;
      }

      await lockTrip(tx, event.tenantId, membership.tripId);
      const lockedMembership = await tx.tripShipment.findFirst({
        where: { id: membership.id, tenantId: event.tenantId, state: 'ACTIVE', removedAt: null, version: membership.version },
        select: { id: true },
      });
      if (!lockedMembership) throw new Error('ShipmentCanceled membership changed while acquiring trip lock; retry required');
      const trip = await tx.deliveryTrip.findFirst({
        where: {
          id: membership.tripId,
          tenantId: event.tenantId,
          deletedAt: null,
        },
      });
      if (!trip) throw new Error('Active shipment membership has no tenant trip');
      if (trip.status !== 'DRAFT' && trip.status !== 'APPROVED')
        throw new Error('ShipmentCanceled requires dispatch authority recovery; trip resources retained');
      await assertNoPending(tx, event.tenantId, trip.id);
      const lockKey = `${event.tenantId}:${membership.tripId}`;
      const pending = await tx.tripOperation.findFirst({
        where: { activeLock: lockKey },
        select: { requestId: true },
      });
      if (pending) {
        throw new Error(`Trip operation ${pending.requestId} blocks ShipmentCanceled consumption`);
      }

      const claimReceipt = membership.claimReceipt as {
        claimId?: unknown;
        tripVersion?: unknown;
      } | null;
      const claimRequest = membership.claimRequest as { actorId?: unknown } | null;
      if (
        !claimReceipt ||
        typeof claimReceipt.claimId !== 'string' ||
        typeof claimReceipt.tripVersion !== 'number' ||
        membership.shipmentVersion === null ||
        typeof claimRequest?.actorId !== 'string'
      ) {
        throw new Error('Active membership is missing its durable claim binding');
      }
      operationId = randomUUID();
      const request: ShipmentReleaseRequest = {
        contractVersion: TRANSPORT_CONTRACT_VERSION,
        tenantId: event.tenantId,
        requestId: randomUUID(),
        claimId: claimReceipt.claimId,
        tripId: membership.tripId,
        shipmentId: membership.shipmentId,
        actorId: claimRequest.actorId,
        expectedTripVersion: toSafeVersion(trip.version + 1n),
        expectedShipmentVersion: event.aggregateVersion,
        reason: 'SHIPMENT_CANCELED',
      };
      await tx.tripOperation.create({
        data: {
          id: operationId,
          tenantId: event.tenantId,
          tripId: membership.tripId,
          requestId: event.eventId,
          actorId: claimRequest.actorId,
          kind: 'SHIPMENT_CANCELED',
          status: 'PENDING',
          payloadHash: event.eventId,
          payload: {
            shipmentIds: [membership.shipmentId],
            membershipIds: [membership.id],
            reason: 'SHIPMENT_CANCELED',
            sourceEventId: event.eventId,
          },
          activeLock: lockKey,
        },
      });
      await tx.tripShipment.update({
        where: { id: membership.id },
        data: {
          operationId,
          state: 'RELEASE_PENDING',
          shipmentVersion: BigInt(event.aggregateVersion),
          releaseRequest: request as unknown as Prisma.InputJsonValue,
        },
      });
      await tx.tripStop.updateMany({
        where: { tenantId: event.tenantId, tripId: membership.tripId },
        data: { approvedSequence: null },
      });
      await tx.tripStop.updateMany({
        where: {
          tenantId: event.tenantId,
          tripId: membership.tripId,
          shipmentId: membership.shipmentId,
          deletedAt: null,
        },
        data: { deletedAt: new Date(), version: { increment: 1 } },
      });
      const active = await tx.tripShipment.findMany({
        where: {
          tenantId: event.tenantId,
          tripId: membership.tripId,
          state: 'ACTIVE',
          removedAt: null,
        },
        select: { weight: true, volume: true },
      });
      const totalWeight = active.reduce(
        (sum, row) => sum.plus(row.weight),
        new Prisma.Decimal(0),
      );
      const totalVolume = active.reduce(
        (sum, row) => sum.plus(row.volume),
        new Prisma.Decimal(0),
      );
      await tx.deliveryTrip.update({
        where: { id: membership.tripId },
        data: {
          totalWeight,
          totalVolume,
          approvedRoutePlanId: null,
          status: 'DRAFT',
          version: { increment: 1 },
        },
      });
      await tx.inboxEvent.create({
        data: {
          tenantId: event.tenantId,
          eventId: event.eventId,
          consumerName: CONSUMER_NAME,
          eventType: event.eventType,
          aggregateId: event.aggregateId,
          aggregateVersion: BigInt(event.aggregateVersion),
          outcome: 'APPLIED',
        },
      });
    });
    if (operationId) await this.memberships.resume(operationId, true);
  }
}
