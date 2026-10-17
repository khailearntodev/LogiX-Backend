import { z } from 'zod';
import type { DomainEventEnvelope } from '../event-envelope.js';

export const SHIPMENT_STATUS = {
  PENDING_PICK: 'PENDING_PICK', PICKING: 'PICKING', READY_TO_SHIP: 'READY_TO_SHIP',
  DISPATCHED: 'DISPATCHED', DELIVERED: 'DELIVERED', FAILED: 'FAILED', CANCELED: 'CANCELED',
} as const;
export type ShipmentStatus = typeof SHIPMENT_STATUS[keyof typeof SHIPMENT_STATUS];
export const SHIPMENT_EVENT = {
  CREATED: 'ShipmentCreated', PICKING: 'ShipmentPicking', READY: 'ShipmentReadyToShip',
  DISPATCHED: 'ShipmentDispatched', DELIVERED: 'ShipmentDelivered',
  FAILED: 'ShipmentDeliveryFailed', CANCELED: 'ShipmentCanceled',
  CANCEL_REJECTED: 'ShipmentCancelRejected',
} as const;
export const SHIPMENT_PERMISSIONS = {
  READ: 'fulfillment:shipment:read', UPDATE: 'fulfillment:shipment:update',
  DISPATCH: 'fulfillment:shipment:dispatch', COMPLETE: 'fulfillment:shipment:complete',
} as const;
export const shipmentQuantity = z.string().regex(/^(?!0+(?:\.0+)?$)\d{1,15}(?:\.\d{1,3})?$/);
const measure = z.string().regex(/^\d{1,15}(?:\.\d{1,6})?$/);
export const shipmentLineSchema = z.object({
  orderLineId: z.string().uuid(), lineNumber: z.number().int().positive(),
  productId: z.string().uuid(), quantity: shipmentQuantity,
  skuSnapshot: z.string().min(1), productNameSnapshot: z.string().min(1),
  unitSnapshot: z.string().min(1), unitWeight: measure, unitVolume: measure,
});
export type ShipmentSourceLine = z.infer<typeof shipmentLineSchema>;
export const confirmedShipmentSchema = z.object({
  orderId: z.string().uuid(), orderNumber: z.string().min(1),
  reservationGroupId: z.string().uuid(), orderVersion: z.number().int().positive().safe(),
  confirmedAt: z.string().datetime(), customerId: z.string().uuid(),
  deliveryAddressId: z.string().uuid(), warehouseId: z.string().uuid(),
  customerSnapshot: z.object({ customerId: z.string().uuid(), code: z.string(), name: z.string() }).passthrough(),
  deliveryAddressSnapshot: z.object({ addressId: z.string().uuid(), addressType: z.literal('SHIPPING'), addressLine: z.string() }).passthrough(),
  warehouseSnapshot: z.object({ warehouseId: z.string().uuid(), code: z.string(), name: z.string() }).passthrough(),
  orderLines: z.array(shipmentLineSchema).nonempty(),
  totalQuantity: shipmentQuantity, totalWeight: measure, totalVolume: measure,
});
export const shipmentLifecycleSchema = z.object({
  shipmentId: z.string().uuid(), orderId: z.string().uuid(),
  reservationGroupId: z.string().uuid(), warehouseId: z.string().uuid(),
  dispatchRequestId: z.string().uuid().nullable(),
  reason: z.string().nullable(),
});
export type ShipmentLifecyclePayload = z.infer<typeof shipmentLifecycleSchema>;
export function validateShipmentEnvelope(event: DomainEventEnvelope, producer: string, aggregateType: string): void {
  z.object({
    eventId: z.string().uuid(), tenantId: z.string().uuid(), correlationId: z.string().uuid(),
    causationId: z.string().uuid(), aggregateId: z.string().uuid(),
    aggregateVersion: z.number().int().positive().safe(), eventVersion: z.literal(1),
    occurredAt: z.string().datetime(), actorId: z.string().uuid().nullable(),
    producer: z.literal(producer), aggregateType: z.literal(aggregateType),
  }).parse(event);
}
