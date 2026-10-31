import { Injectable } from '@nestjs/common';
import {
  batchDispatchGrantDecisionSchema,
  batchDispatchGrantRequestSchema,
  hashTransportContractPayload,
  type BatchDispatchGrantDecision,
  type BatchDispatchGrantRequest,
} from '@logix/messaging';
import { PrismaService } from '../../database/prisma.service.js';
import { lockOrder } from './order-lock.js';
import { OrderErrors } from '../domain/order-errors.js';

@Injectable()
export class OrderDispatchBatchService {
  constructor(private readonly prisma: PrismaService) {}

  async authorize(raw: BatchDispatchGrantRequest): Promise<BatchDispatchGrantDecision> {
    const request = batchDispatchGrantRequestSchema.parse(raw);
    return this.prisma.$transaction(async (tx) => {
      // Serialize request-key reuse even when the competing payload names disjoint Orders.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${request.tenantId}:dispatch:${request.requestId}`}, 0))::text`;
      const prior = await tx.orderDispatchBatch.findFirst({
        where: { tenantId: request.tenantId, id: request.requestId },
      });
      if (prior) {
        if (hashTransportContractPayload(batchDispatchGrantRequestSchema.parse(prior.payload)) !== hashTransportContractPayload(request))
          throw OrderErrors.dispatchRequestConflict(request.shipments[0].orderId);
        return batchDispatchGrantDecisionSchema.parse(prior.decision);
      }
      const items = [...request.shipments].sort((a, b) => a.orderId.localeCompare(b.orderId));
      for (const item of items) await lockOrder(tx, request.tenantId, item.orderId);
      let reasonCode: string | null = null;
      for (const item of items) {
        const order = await tx.salesOrder.findFirst({
          where: { id: item.orderId, tenantId: request.tenantId, deletedAt: null },
        });
        if (!order || order.dispatchGrantedAt || order.cancellationRequestedAt ||
          order.status !== 'READY_TO_SHIP' || order.version !== BigInt(item.orderVersion) ||
          order.reservationGroupId !== item.reservationGroupId) {
          reasonCode = 'ORDER_NOT_DISPATCHABLE';
          break;
        }
        const used = await tx.salesOrder.findFirst({
          where: { tenantId: request.tenantId, dispatchRequestId: item.dispatchRequestId },
          select: { id: true },
        });
        if (used) { reasonCode = 'CHILD_REQUEST_ALREADY_USED'; break; }
      }
      const decidedAt = new Date();
      const binding = {
        contractVersion: request.contractVersion, tenantId: request.tenantId,
        requestId: request.requestId, tripId: request.tripId, actorId: request.actorId,
        dispatchVersion: request.dispatchVersion, approvedPlanId: request.approvedPlanId,
        inputHash: request.inputHash, decidedAt: decidedAt.toISOString(),
      };
      const decision = batchDispatchGrantDecisionSchema.parse(reasonCode
        ? { ...binding, decision: 'REJECTED', grantCount: 0, reasonCode }
        : {
            ...binding, decision: 'GRANTED',
            grants: request.shipments.map((item) => ({
              shipmentId: item.shipmentId, orderId: item.orderId,
              grantId: item.dispatchRequestId, orderVersion: item.orderVersion,
              reservationGroupId: item.reservationGroupId,
              dispatchRequestId: item.dispatchRequestId,
            })),
          });
      if (decision.decision === 'GRANTED') {
        for (const item of items) {
          await tx.salesOrder.update({
            where: { id: item.orderId, tenantId: request.tenantId },
            data: {
              dispatchRequestId: item.dispatchRequestId, dispatchShipmentId: item.shipmentId,
              dispatchOrderVersion: BigInt(item.orderVersion), dispatchActorId: request.actorId,
              dispatchCorrelationId: request.requestId, dispatchGrantedAt: decidedAt,
              version: { increment: 1 },
            },
          });
        }
      }
      await tx.orderDispatchBatch.create({
        data: { id: request.requestId, tenantId: request.tenantId, payload: request, decision },
      });
      return decision;
    });
  }
}
