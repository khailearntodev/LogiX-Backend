import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ServiceId } from '@logix/common';
import type { DomainEventEnvelope } from '@logix/messaging';
import { z } from 'zod';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { OrderReservationService } from './order-reservation.service.js';
import { ORDER_STATUS } from '../domain/order-status.js';

const CONSUMER_NAME = 'order-stock-events';
const receivedPayload = z.object({
  warehouseId: z.string().uuid(),
  productId: z.string().uuid(),
});
const releasedPayload = z.object({
  warehouseId: z.string().uuid(),
  items: z.array(z.object({ productId: z.string().uuid() })).nonempty(),
});
const pendingPayload = z.object({
  warehouseId: z.string().uuid(),
  shortageItems: z.array(z.object({ productId: z.string().uuid() })).nonempty(),
});
const updatedPayload = z.object({
  status: z.string(),
  warehouseId: z.string().uuid(),
  orderLines: z.array(z.object({ productId: z.string().uuid() })).nonempty(),
});

@Injectable()
export class OrderStockEventsService {
  private readonly logger = new Logger(OrderStockEventsService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly reservations: OrderReservationService,
    private readonly config: ConfigService,
  ) {}

  async handle(event: DomainEventEnvelope): Promise<void> {
    if (
      event.eventType !== 'StockReceived' &&
      event.eventType !== 'StockReleased' &&
      event.eventType !== 'OrderPendingStock' &&
      event.eventType !== 'OrderUpdated'
    )
      return;
    const expectedProducer = event.eventType.startsWith('Order')
      ? ServiceId.ORDER_SERVICE
      : ServiceId.INVENTORY_SERVICE;
    if (event.producer !== expectedProducer)
      throw new Error('Unexpected inventory event producer');
    z.string().uuid().parse(event.tenantId);
    z.string().uuid().parse(event.eventId);
    z.string().uuid().parse(event.correlationId);
    if (
      event.eventType === 'OrderUpdated' &&
      updatedPayload.parse(event.payload).status !== ORDER_STATUS.PENDING_STOCK
    )
      return;
    const payload =
      event.eventType === 'StockReceived'
        ? receivedPayload.parse(event.payload)
        : event.eventType === 'StockReleased'
          ? releasedPayload.parse(event.payload)
          : event.eventType === 'OrderUpdated'
            ? updatedPayload.parse(event.payload)
            : pendingPayload.parse(event.payload);
    const products =
      'productId' in payload
        ? [payload.productId]
        : ('items' in payload
            ? payload.items
            : 'orderLines' in payload
              ? payload.orderLines
              : payload.shortageItems
          ).map((item) => item.productId);
    await this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock(hashtextextended(${`${event.tenantId}:${payload.warehouseId}:pending-fifo`}, 0))::text
      `);
        if (
          await tx.inboxEvent.findUnique({
            where: {
              consumerName_eventId: {
                consumerName: CONSUMER_NAME,
                eventId: event.eventId,
              },
            },
          })
        )
          return;
        const orders = await tx.salesOrder.findMany({
          where: {
            tenantId: event.tenantId,
            warehouseId: payload.warehouseId,
            status: ORDER_STATUS.PENDING_STOCK,
            cancellationRequestedAt: null,
            deletedAt: null,
            lines: { some: { productId: { in: products }, deletedAt: null } },
          },
          orderBy: [{ pendingSince: 'asc' }, { id: 'asc' }],
        });
        for (const order of orders) {
          // Per-order inbox commits with the reservation decision. A later failure
          // can replay the warehouse event without repeating successful decisions.
          try {
            await this.reservations.confirm(
              order.id,
              Number(order.version),
              {
                tenantId: event.tenantId,
                actorId: null,
                correlationId: event.correlationId,
                eventId: event.eventId,
                eventType: event.eventType,
              },
              true,
            );
          } catch (error) {
            // Concurrent UI edits/cancellation are authoritative; do not retry stale content.
            if (!(
              error instanceof Error &&
              'reason' in error &&
              (error.reason === 'ORDER_VERSION_CONFLICT' ||
                error.reason === 'ORDER_INVALID_TRANSITION')
            )) {
              throw error;
            }
            this.logger.warn(
              {
                orderId: order.id,
                eventId: event.eventId,
                correlationId: event.correlationId,
                reason: error.reason,
              },
              'FIFO candidate changed concurrently; stale candidate skipped',
            );
          }
        }
        await tx.inboxEvent.create({
          data: {
            tenantId: event.tenantId,
            eventId: event.eventId,
            consumerName: CONSUMER_NAME,
            eventType: event.eventType,
            aggregateId: event.aggregateId,
            aggregateVersion: BigInt(event.aggregateVersion),
            outcome: 'PROCESSED',
          },
        });
      },
      {
        timeout: this.config.getOrThrow<number>(
          'OUTBOX_TRANSACTION_TIMEOUT_MS',
        ),
      },
    );
  }
}
