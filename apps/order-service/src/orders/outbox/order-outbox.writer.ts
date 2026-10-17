import { Injectable } from '@nestjs/common';
import type { DomainEventMap } from '@logix/messaging';
import type { Prisma } from '../../generated/prisma/client.js';
import {
  ORDER_EVENT_VERSION,
  SALES_ORDER_AGGREGATE,
  type OrderEventType,
} from '../domain/order-constants.js';

export interface OrderOutboxRecord<E extends OrderEventType> {
  tenantId: string;
  eventType: E;
  orderId: string;
  orderVersion: bigint;
  correlationId: string;
  actorId?: string | null;
  causationId?: string;
  occurredAt: Date;
  payload: DomainEventMap[E];
}

/**
 * Persists order domain events inside the caller's transaction. Publishing is
 * handled by the outbox relay; this writer never talks to the broker.
 */
@Injectable()
export class OrderOutboxWriter {
  async write<E extends OrderEventType>(
    tx: Prisma.TransactionClient,
    record: OrderOutboxRecord<E>,
  ): Promise<void> {
    await tx.outboxEvent.create({
      data: {
        tenantId: record.tenantId,
        eventType: record.eventType,
        eventVersion: ORDER_EVENT_VERSION,
        aggregateType: SALES_ORDER_AGGREGATE,
        aggregateId: record.orderId,
        aggregateVersion: record.orderVersion,
        correlationId: record.correlationId,
        causationId: record.causationId ?? record.correlationId,
        payload: {
          ...record.payload,
          actorId: record.actorId ?? null,
        } as unknown as Prisma.InputJsonObject,
        occurredAt: record.occurredAt,
      },
    });
  }
}
