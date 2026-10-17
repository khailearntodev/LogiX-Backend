import { Injectable } from '@nestjs/common';
import type {
  AuthorizeOrderDispatchRequest,
  OrderDispatchGrant,
} from '@logix/messaging';
import { Prisma, type SalesOrder } from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { OrderErrors } from '../domain/order-errors.js';
import { ORDER_STATUS } from '../domain/order-status.js';
import { lockOrder } from './order-lock.js';

@Injectable()
export class OrderDispatchService {
  constructor(private readonly prisma: PrismaService) {}

  async authorize(
    tenantId: string,
    orderId: string,
    request: AuthorizeOrderDispatchRequest,
    correlationId: string,
  ): Promise<OrderDispatchGrant> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await lockOrder(tx, tenantId, orderId);
        const order = await tx.salesOrder.findFirst({
          where: { id: orderId, tenantId, deletedAt: null },
        });
        if (!order) throw OrderErrors.notFound(orderId);
        if (order.dispatchGrantedAt) {
          const grant = this.toGrant(order);
          if (
            grant.requestId !== request.requestId ||
            grant.shipmentId !== request.shipmentId ||
            grant.reservationGroupId !== request.reservationGroupId ||
            grant.orderVersion !== request.orderVersion ||
            grant.actorId !== request.actorId
          ) {
            throw OrderErrors.dispatchRequestConflict(orderId);
          }
          return grant;
        }
        if (order.cancellationRequestedAt) {
          throw OrderErrors.invalidTransition(
            orderId,
            order.status,
            'CANCELLATION_PENDING',
          );
        }
        if (order.status !== ORDER_STATUS.READY_TO_SHIP) {
          throw OrderErrors.invalidTransition(
            orderId,
            order.status,
            'DISPATCH',
          );
        }
        if (order.version !== BigInt(request.orderVersion)) {
          throw OrderErrors.versionConflict(
            orderId,
            request.orderVersion,
            Number(order.version),
          );
        }
        if (
          !order.reservationGroupId ||
          order.reservationGroupId !== request.reservationGroupId
        ) {
          throw OrderErrors.reservationMismatch(orderId);
        }
        const granted = await tx.salesOrder.update({
          where: { id: orderId, tenantId },
          data: {
            dispatchRequestId: request.requestId,
            dispatchShipmentId: request.shipmentId,
            dispatchOrderVersion: BigInt(request.orderVersion),
            dispatchActorId: request.actorId,
            dispatchCorrelationId: correlationId,
            dispatchGrantedAt: new Date(),
            version: { increment: 1 },
          },
        });
        return this.toGrant(granted);
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw OrderErrors.dispatchRequestConflict(orderId);
      }
      throw error;
    }
  }

  private toGrant(order: SalesOrder): OrderDispatchGrant {
    if (
      !order.dispatchRequestId ||
      !order.dispatchShipmentId ||
      order.dispatchOrderVersion === null ||
      !order.dispatchGrantedAt ||
      !order.dispatchActorId ||
      !order.dispatchCorrelationId ||
      !order.reservationGroupId
    ) {
      throw new Error('Incomplete persisted order dispatch decision');
    }
    return {
      orderId: order.id,
      requestId: order.dispatchRequestId,
      shipmentId: order.dispatchShipmentId,
      reservationGroupId: order.reservationGroupId,
      orderVersion: Number(order.dispatchOrderVersion),
      actorId: order.dispatchActorId,
      grantedAt: order.dispatchGrantedAt.toISOString(),
      correlationId: order.dispatchCorrelationId,
    };
  }
}
