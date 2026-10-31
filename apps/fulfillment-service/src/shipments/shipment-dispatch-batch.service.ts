import { Injectable } from '@nestjs/common';
import { BusinessRuleViolationError, EntityNotFoundError } from '@logix/errors';
import {
  assertBatchDispatchGrantBinding,
  batchDispatchGrantDecisionSchema,
  batchDispatchGrantRequestSchema,
  hashTransportContractPayload,
  shipmentDispatchBatchReceiptSchema,
  SHIPMENT_EVENT,
  type BatchDispatchGrantRequest,
} from '@logix/messaging';
import { PrismaService } from '../database/prisma.service.js';
import { OrderClient } from './order.client.js';
import { lockShipment, recordShipment } from './shipment.persistence.js';
import { ShipmentErrors } from './shipment.domain.js';

@Injectable()
export class ShipmentDispatchBatchService {
  constructor(private readonly prisma: PrismaService, private readonly orders: OrderClient) {}

  async readiness(tenantId: string, tripId: string, items: Array<{ shipmentId: string; shipmentVersion: number }>) {
    const result = [];
    for (const item of items) {
      const shipment = await this.prisma.shipment.findFirst({
        where: { id: item.shipmentId, tenantId, deletedAt: null }, include: { dispatchIntent: true },
      });
      if (!shipment || shipment.assignedTripId !== tripId || !shipment.tripClaimId ||
        shipment.version !== BigInt(item.shipmentVersion) || shipment.status !== 'READY_TO_SHIP' ||
        (shipment.dispatchIntent && shipment.dispatchIntent.status !== 'REJECTED'))
        throw ShipmentErrors.tripClaimConflict();
      const order = await this.orders.snapshot(shipment.orderId, { tenantId, actorId: null, correlationId: tripId });
      if (order.status !== 'READY_TO_SHIP' || order.cancellationRequestedAt ||
        order.reservationGroupId !== shipment.reservationGroupId) throw ShipmentErrors.transition();
      result.push({
        shipmentId: shipment.id, shipmentVersion: item.shipmentVersion, orderId: shipment.orderId,
        orderVersion: order.version, reservationGroupId: shipment.reservationGroupId,
      });
    }
    return result;
  }

  async dispatch(raw: BatchDispatchGrantRequest) {
    const request = batchDispatchGrantRequestSchema.parse(raw);
    const payloadHash = hashTransportContractPayload(request);
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${request.tenantId}:dispatch:${request.requestId}`}, 0))::text`;
      const prior = await tx.shipmentDispatchBatch.findFirst({ where: { id: request.requestId, tenantId: request.tenantId } });
      if (prior) {
        if (prior.payloadHash !== payloadHash) throw ShipmentErrors.tripRequestConflict();
        return;
      }
      for (const item of [...request.shipments].sort((a, b) => a.shipmentId.localeCompare(b.shipmentId)))
        await lockShipment(tx, request.tenantId, item.shipmentId);
      const prepared: Array<{ item: BatchDispatchGrantRequest['shipments'][number]; priorId: string | null }> = [];
      for (const item of request.shipments) {
        const shipment = await tx.shipment.findFirst({
          where: { id: item.shipmentId, tenantId: request.tenantId, deletedAt: null },
          include: { dispatchIntent: true },
        });
        if (!shipment || shipment.orderId !== item.orderId ||
          shipment.reservationGroupId !== item.reservationGroupId ||
          shipment.assignedTripId !== request.tripId || !shipment.tripClaimId ||
          shipment.status !== 'READY_TO_SHIP' || shipment.version !== BigInt(item.shipmentVersion) ||
          (shipment.dispatchIntent && shipment.dispatchIntent.status !== 'REJECTED')) {
          const response = shipmentDispatchBatchReceiptSchema.parse({
            tenantId: request.tenantId, tripId: request.tripId, requestId: request.requestId,
            payloadHash, status: 'REJECTED', stage: 'REJECTED', decision: null, shipments: [],
          });
          await tx.shipmentDispatchBatch.create({
            data: {
              id: request.requestId, tenantId: request.tenantId, tripId: request.tripId,
              payload: request, payloadHash, status: 'REJECTED', stage: 'REJECTED',
              response, lastError: 'SHIPMENT_NOT_DISPATCHABLE',
            },
          });
          return;
        }
        prepared.push({ item, priorId: shipment.dispatchIntent?.id ?? null });
      }
      for (const { item, priorId } of prepared) {
        if (priorId) await tx.shipmentDispatchIntent.delete({ where: { id: priorId } });
        await tx.shipmentDispatchIntent.create({
          data: {
            id: item.dispatchRequestId, tenantId: request.tenantId, shipmentId: item.shipmentId,
            orderVersion: BigInt(item.orderVersion), shipmentVersion: BigInt(item.shipmentVersion),
            actorId: request.actorId, correlationId: request.requestId, batchId: request.requestId,
            status: 'PENDING',
          },
        });
      }
      await tx.shipmentDispatchBatch.create({
        data: {
          id: request.requestId, tenantId: request.tenantId, tripId: request.tripId,
          payload: request, payloadHash, status: 'PENDING', stage: 'PREPARED',
        },
      });
    });
    await this.complete(request.tenantId, request.requestId);
    return this.receipt(request.tenantId, request.requestId);
  }

  async receipt(tenantId: string, requestId: string) {
    const batch = await this.prisma.shipmentDispatchBatch.findFirst({ where: { tenantId, id: requestId } });
    if (!batch) throw new EntityNotFoundError('ShipmentDispatchBatch', requestId);
    if (batch.response) return shipmentDispatchBatchReceiptSchema.parse(batch.response);
    return shipmentDispatchBatchReceiptSchema.parse({
      tenantId, requestId, tripId: batch.tripId, payloadHash: batch.payloadHash,
      status: batch.status, stage: batch.stage, decision: batch.decision, shipments: [],
    });
  }

  async complete(tenantId: string, requestId: string) {
    const batch = await this.prisma.shipmentDispatchBatch.findFirst({ where: { tenantId, id: requestId } });
    if (!batch || batch.status !== 'PENDING') return;
    const request = batchDispatchGrantRequestSchema.parse(batch.payload);
    const decision = batch.decision
      ? batchDispatchGrantDecisionSchema.parse(batch.decision)
      : await this.orders.authorizeBatch(request);
    assertBatchDispatchGrantBinding(request, decision);
    // Persist the authority receipt before the separate local lifecycle transaction.
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM fulfillment.shipment_dispatch_batches WHERE id=${requestId}::uuid AND tenant_id=${tenantId}::uuid FOR UPDATE`;
      const current = await tx.shipmentDispatchBatch.findFirstOrThrow({ where: { tenantId, id: requestId } });
      if (current.status !== 'PENDING') return;
      await tx.shipmentDispatchBatch.update({
        where: { id: requestId },
        data: { decision, stage: decision.decision === 'GRANTED' ? 'GRANTED' : 'REJECTED' },
      });
      if (decision.decision === 'GRANTED') {
        for (const item of request.shipments) {
          await tx.shipmentDispatchIntent.update({
            where: { id: item.dispatchRequestId }, data: { grantReceipt: decision },
          });
        }
      }
    });
    await this.commit(tenantId, requestId);
  }

  async commit(tenantId: string, requestId: string) {
    const batch = await this.prisma.shipmentDispatchBatch.findFirstOrThrow({ where: { tenantId, id: requestId } });
    if (batch.status !== 'PENDING') return;
    const request = batchDispatchGrantRequestSchema.parse(batch.payload);
    const decision = batchDispatchGrantDecisionSchema.parse(batch.decision);
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM fulfillment.shipment_dispatch_batches WHERE id=${requestId}::uuid AND tenant_id=${tenantId}::uuid FOR UPDATE`;
      const current = await tx.shipmentDispatchBatch.findFirstOrThrow({ where: { tenantId, id: requestId } });
      if (current.status !== 'PENDING') return;
      for (const item of [...request.shipments].sort((a, b) => a.shipmentId.localeCompare(b.shipmentId)))
        await lockShipment(tx, tenantId, item.shipmentId);
      const receipts = [];
      for (const item of request.shipments) {
        if (decision.decision === 'REJECTED') {
          await tx.shipmentDispatchIntent.updateMany({
            where: { id: item.dispatchRequestId, tenantId, status: 'PENDING' },
            data: { status: 'REJECTED', rejectionReason: decision.reasonCode },
          });
          continue;
        }
        const shipment = await tx.shipment.findFirstOrThrow({
          where: { id: item.shipmentId, tenantId }, include: { dispatchIntent: true },
        });
        if (shipment.status !== 'READY_TO_SHIP' || shipment.assignedTripId !== request.tripId ||
          shipment.dispatchIntent?.id !== item.dispatchRequestId || !shipment.dispatchIntent.grantReceipt)
          throw new BusinessRuleViolationError('BATCH_GRANTED_SHIPMENT_BINDING_CHANGED');
        const updated = await tx.shipment.update({
          where: { id: shipment.id }, data: {
            status: 'DISPATCHED', dispatchIssuedAt: new Date(decision.decidedAt), version: { increment: 1 },
          },
        });
        await tx.shipmentDispatchIntent.update({ where: { id: item.dispatchRequestId }, data: { status: 'COMPLETED' } });
        await recordShipment(tx, updated, shipment.status, SHIPMENT_EVENT.DISPATCHED, {
          tenantId, actorId: request.actorId, correlationId: requestId,
        }, null, item.dispatchRequestId);
        receipts.push({ shipmentId: item.shipmentId, dispatchRequestId: item.dispatchRequestId, shipmentVersion: Number(updated.version) });
      }
      const status = decision.decision === 'GRANTED' ? 'COMPLETED' : 'REJECTED';
      const response = shipmentDispatchBatchReceiptSchema.parse({
        tenantId, requestId, tripId: request.tripId, payloadHash: batch.payloadHash,
        status, stage: status, decision, shipments: receipts,
      });
      await tx.shipmentDispatchBatch.update({ where: { id: requestId }, data: { status, stage: status, response } });
    });
  }
}
