import { Injectable } from '@nestjs/common';
import { ServiceId } from '@logix/common';
import {
  SHIPMENT_EVENT as E,
  shipmentLifecycleSchema,
  validateShipmentEnvelope,
  type DomainEventEnvelope,
} from '@logix/messaging';
import { PrismaService } from '../../database/prisma.service.js';
import { lockOrder } from './order-lock.js';
import { ORDER_STATUS as S, type OrderStatus } from '../domain/order-status.js';
import { canTransition } from '../domain/order-state-machine.js';

const CONSUMER = 'order-shipment-lifecycle';
const TARGETS: Record<string, OrderStatus> = {
  [E.PICKING]: S.PICKING,
  [E.READY]: S.READY_TO_SHIP,
  [E.DISPATCHED]: S.IN_DELIVERY,
  [E.DELIVERED]: S.COMPLETED,
  [E.FAILED]: S.DELIVERY_FAILED,
};
@Injectable()
export class OrderShipmentEventsService {
  constructor(private readonly prisma: PrismaService) {}
  async handle(event: DomainEventEnvelope): Promise<void> {
    const target = TARGETS[event.eventType];
    if (!target) return;
    validateShipmentEnvelope(event, ServiceId.FULFILLMENT_SERVICE, 'Shipment');
    const payload = shipmentLifecycleSchema.parse(event.payload);
    if (payload.shipmentId !== event.aggregateId)
      throw new Error('Shipment aggregate mismatch');
    await this.prisma.$transaction(async (tx) => {
      await lockOrder(tx, event.tenantId, payload.orderId);
      const key = { consumerName: CONSUMER, eventId: event.eventId };
      if (
        await tx.inboxEvent.findUnique({ where: { consumerName_eventId: key } })
      )
        return;
      const order = await tx.salesOrder.findFirst({
        where: {
          tenantId: event.tenantId,
          id: payload.orderId,
          deletedAt: null,
        },
      });
      if (!order) throw new Error('Shipment references unknown order');
      if (
        order.reservationGroupId !== payload.reservationGroupId ||
        order.warehouseId !== payload.warehouseId ||
        (order.dispatchShipmentId &&
          order.dispatchShipmentId !== payload.shipmentId)
      )
        throw new Error('Shipment projection ownership mismatch');
      const previous = await tx.inboxEvent.findFirst({
        where: {
          tenantId: event.tenantId,
          consumerName: CONSUMER,
          aggregateId: payload.shipmentId,
          outcome: 'APPLIED',
        },
        orderBy: { aggregateVersion: 'desc' },
      });
      let outcome = 'IGNORED_STALE';
      if (
        (!previous?.aggregateVersion ||
          previous.aggregateVersion < BigInt(event.aggregateVersion)) &&
        !order.cancellationRequestedAt &&
        canTransition(order.status as OrderStatus, target) &&
        !(target === S.IN_DELIVERY && order.status !== S.READY_TO_SHIP)
      ) {
        if (
          target === S.IN_DELIVERY &&
          (order.dispatchRequestId !== payload.dispatchRequestId ||
            !order.dispatchGrantedAt)
        )
          throw new Error('Dispatch event has no matching Order grant');
        const updated = await tx.salesOrder.update({
          where: { id: order.id },
          data: {
            status: target,
            version: { increment: 1 },
            ...(target === S.COMPLETED && {
              completedAt: new Date(event.occurredAt),
            }),
          },
        });
        await tx.orderStatusHistory.create({
          data: {
            tenantId: event.tenantId,
            orderId: order.id,
            fromStatus: order.status,
            toStatus: target,
            actorId: event.actorId,
            correlationId: event.correlationId,
            orderVersion: updated.version,
            reason: payload.reason,
          },
        });
        // Projection does not emit OrderUpdated: that event means a draft-content edit, not fulfillment ownership.
        outcome = 'APPLIED';
      }
      await tx.inboxEvent.create({
        data: {
          ...key,
          tenantId: event.tenantId,
          eventType: event.eventType,
          aggregateId: event.aggregateId,
          aggregateVersion: BigInt(event.aggregateVersion),
          outcome,
        },
      });
    });
  }
}
