import { Injectable } from '@nestjs/common';
import type { DomainEventEnvelope } from '@logix/messaging';
import { ServiceId } from '@logix/common';
import { z } from 'zod';
import { PrismaService } from '../../database/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import { ReservationService } from './reservation.service.js';

const acknowledgedPayload = z.object({
  orderId: z.string().uuid(),
  reservationGroupId: z.string().uuid(),
});

@Injectable()
export class ReservationOrderEventsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reservations: ReservationService,
  ) {}

  async handle(event: DomainEventEnvelope): Promise<void> {
    if (
      event.eventType !== 'OrderCanceled' &&
      event.eventType !== 'OrderConfirmed'
    )
      return;
    if (event.producer !== ServiceId.ORDER_SERVICE)
      throw new Error('Unexpected order event producer');
    z.string().uuid().parse(event.eventId);
    z.string().uuid().parse(event.tenantId);
    z.string().uuid().parse(event.correlationId);
    if (event.eventType === 'OrderCanceled') {
      const payload = z
        .object({ orderId: z.string().uuid() })
        .parse(event.payload);
      await this.reservations.release(payload.orderId, {
        tenantId: event.tenantId,
        correlationId: event.correlationId,
        eventId: event.eventId,
      });
      return;
    }
    const payload = acknowledgedPayload.parse(event.payload);
    const consumerName = 'inventory-order-confirmation';
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock(hashtextextended(${`${event.tenantId}:${payload.orderId}`}, 0))::text
      `);
      if (
        await tx.inboxEvent.findUnique({
          where: {
            consumerName_eventId: { consumerName, eventId: event.eventId },
          },
        })
      )
        return;
      const group = await tx.reservationGroup.findFirst({
        where: {
          id: payload.reservationGroupId,
          tenantId: event.tenantId,
          orderId: payload.orderId,
        },
      });
      if (!group)
        throw new Error('OrderConfirmed references an unknown reservation');
      await tx.reservationGroup.update({
        where: { id: group.id, tenantId: event.tenantId },
        data: { acknowledgedAt: new Date(), version: { increment: 1 } },
      });
      await tx.inboxEvent.create({
        data: {
          tenantId: event.tenantId,
          consumerName,
          eventId: event.eventId,
          eventType: event.eventType,
          aggregateId: event.aggregateId,
          aggregateVersion: BigInt(event.aggregateVersion),
          outcome: 'ACKNOWLEDGED',
        },
      });
    });
  }
}
