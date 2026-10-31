import { Prisma, type Shipment } from '../generated/prisma/client.js';
import type { ShipmentLifecyclePayload } from '@logix/messaging';
import { SHIPMENT_AGGREGATE } from './shipment.domain.js';

export interface ShipmentContext {
  tenantId: string;
  actorId: string | null;
  correlationId: string;
  causationId?: string;
}
export async function lockShipment(
  tx: Prisma.TransactionClient,
  tenantId: string,
  id: string,
) {
  await tx.$queryRaw(Prisma.sql`SELECT id FROM fulfillment.shipments
    WHERE id=${id}::uuid AND tenant_id=${tenantId}::uuid AND deleted_at IS NULL FOR UPDATE`);
}
export async function recordShipment(
  tx: Prisma.TransactionClient,
  shipment: Shipment,
  fromStatus: string | null,
  eventType: string,
  ctx: ShipmentContext,
  reason: string | null = null,
  dispatchRequestId: string | null = null,
) {
  const now = new Date();
  await tx.shipmentStatusHistory.create({
    data: {
      tenantId: shipment.tenantId,
      shipmentId: shipment.id,
      fromStatus,
      toStatus: shipment.status,
      shipmentVersion: shipment.version,
      actorId: ctx.actorId,
      correlationId: ctx.correlationId,
      reason,
    },
  });
  const payload: ShipmentLifecyclePayload = {
    shipmentId: shipment.id,
    orderId: shipment.orderId,
    warehouseId: shipment.warehouseId,
    reservationGroupId: shipment.reservationGroupId,
    dispatchRequestId,
    reason,
  };
  await tx.outboxEvent.create({
    data: {
      tenantId: shipment.tenantId,
      aggregateType: SHIPMENT_AGGREGATE,
      aggregateId: shipment.id,
      aggregateVersion: shipment.version,
      eventType,
      eventVersion: 1,
      occurredAt: now,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId ?? ctx.correlationId,
      payload: { ...payload, actorId: ctx.actorId },
    },
  });
}

// Prisma decimals remain strings; versions are bounded by the public safe-integer contract.
export function shipmentView<T>(value: T): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item !== 'bigint') return item;
      const number = Number(item);
      if (!Number.isSafeInteger(number))
        throw new Error('Shipment version exceeds safe integer range');
      return number;
    }),
    (key, item: unknown) => {
      if (key === 'tripClaimId') return undefined;
      return item;
    },
  );
}
