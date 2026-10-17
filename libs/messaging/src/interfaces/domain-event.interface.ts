/**
 * Domain event type definitions matching the event catalogue.
 * @see docs/architecture/event-architecture.md §3
 *
 * Each event type has a corresponding payload interface.
 * These interfaces serve as shared contracts between producers and consumers.
 *
 * Note: Business logic does NOT belong in this shared contract package.
 * @see docs/architecture/event-architecture.md §11
 */

import type { ShipmentLifecyclePayload } from './shipment.contract.js';

// ─── Shared Snapshots ───────────────────────────────────────────────────────
// Immutable copies of Master Data / Identity records carried inside events so
// consumers never read another service's database. Shapes mirror the JSON
// stored in *_snapshot columns. @see docs/architecture/data-ownership.md

export interface AddressSnapshot {
  addressId: string;
  addressVersion: number;
  addressType: 'SHIPPING' | 'BILLING';
  label: string | null;
  recipientName: string;
  phone: string | null;
  addressLine: string;
  ward: string | null;
  district: string | null;
  province: string;
  postalCode: string | null;
  latitude: string | null;
  longitude: string | null;
  deliveryNote: string | null;
}

export interface CustomerSnapshot {
  customerId: string;
  customerVersion: number;
  code: string;
  name: string;
  taxCode: string | null;
  phone: string | null;
  email: string | null;
}

export interface WarehouseSnapshot {
  warehouseId: string;
  warehouseVersion: number;
  code: string;
  name: string;
  addressLine: string;
  ward: string | null;
  district: string | null;
  province: string;
  postalCode: string | null;
  latitude: string | null;
  longitude: string | null;
}

/** Tenant legal profile printed as the issuer on dispatch documents. */
export interface IssuerSnapshot {
  tenantId: string;
  legalName: string;
  taxCode: string | null;
  phone: string | null;
  addressLine: string;
  ward: string | null;
  district: string | null;
  province: string;
  postalCode: string | null;
}

// ─── Order Events ───────────────────────────────────────────────────────────

/** Quantities and totals are decimal strings so Decimal(18,3)/(18,6) survive JSON. */
export interface OrderLinePayload {
  lineNumber: number;
  productId: string;
  quantity: string;
}

export interface OrderDraftPayload {
  orderId: string;
  orderNumber: string;
  status: string;
  customerId: string;
  deliveryAddressId: string;
  warehouseId: string;
  currency: string;
  totalQuantity: string;
  totalWeight: string;
  totalVolume: string;
  orderLines: OrderLinePayload[];
}

export type OrderCreatedPayload = OrderDraftPayload;

export type OrderUpdatedPayload = OrderDraftPayload;

export interface OrderCanceledPayload {
  orderId: string;
  orderNumber: string;
  previousStatus: string;
  canceledAt: string;
  reason: string;
}

export interface OrderConfirmedPayload {
  orderId: string;
  orderNumber: string;
  reservationGroupId: string;
  orderVersion: number;
  confirmedAt: string;
  customerId: string;
  deliveryAddressId: string;
  warehouseId: string;
  customerSnapshot: CustomerSnapshot;
  deliveryAddressSnapshot: AddressSnapshot;
  warehouseSnapshot: WarehouseSnapshot;
  orderLines: Array<OrderLinePayload & {
    orderLineId: string;
    /** Additive fields; legacy events resolve locked line snapshots through Order's internal API. */
    skuSnapshot?: string;
    productNameSnapshot?: string;
    unitSnapshot?: string;
    unitWeight?: string;
    unitVolume?: string;
  }>;
  totalQuantity: string;
  totalWeight: string;
  totalVolume: string;
}

export interface OrderPendingStockPayload {
  orderId: string;
  warehouseId: string;
  pendingSince: string;
  shortageItems: Array<{
    productId: string;
    requestedQuantity: string;
    availableQuantity: string;
  }>;
}

// ─── Inventory Events ───────────────────────────────────────────────────────

/**
 * Payload written by inventory-service for every stock movement outbox event.
 * Quantities are decimal strings with 3 fractional digits to avoid float loss.
 */
export interface StockMovementPayload {
  movementId: string;
  warehouseId: string;
  productId: string;
  movementType: string;
  quantityDelta: string;
  beforeOnHand: string;
  afterOnHand: string;
  reservedQuantity: string;
  referenceType: string;
  referenceId: string;
  reason: string | null;
  actorId: string;
}

export interface StockReceivedPayload extends StockMovementPayload {
  quantity: string;
}

export interface StockReservationPayload {
  reservationGroupId: string;
  orderId: string;
  orderVersion: string;
  warehouseId: string;
  items: Array<{ productId: string; quantity: string }>;
}

export interface InventoryReservedPayload {
  reservationGroupId: string;
  orderId: string;
  warehouseId: string;
  items: Array<{
    productId: string;
    reservedQuantity: number;
  }>;
}

export type InventoryAdjustedPayload = StockMovementPayload;

// ─── Fulfillment Events ─────────────────────────────────────────────────────

export interface ShipmentReadyPayload {
  shipmentId: string;
  orderId: string;
  warehouseId: string;
  deliveryAddressId: string;
  /** Copied verbatim into transport.trip_stops.address_snapshot. */
  deliveryAddressSnapshot: AddressSnapshot;
  customerSnapshot: CustomerSnapshot;
  totalWeight: string;
  totalVolume: string;
}

// ─── Transport Events ───────────────────────────────────────────────────────

export interface TripPlannedPayload {
  tripId: string;
  warehouseId: string;
  vehicleId: string;
  driverId: string;
  shipmentIds: string[];
}

export interface RouteOptimizedPayload {
  routeRequestId: string;
  tripId: string;
  totalDistance: number;
  totalDuration: number;
  stopSequence: Array<{
    stopId: string;
    sequence: number;
  }>;
}

export interface RouteApprovedPayload {
  routePlanId: string;
  tripId: string;
  approvedBy: string;
}

export interface TripDispatchedPayload {
  tripId: string;
  dispatchedAt: string;
}

export interface DeliveryCompletedPayload {
  stopId: string;
  attempt: number;
  deliveredAt: string;
  receivedBy?: string;
}

export interface DeliveryFailedPayload {
  stopId: string;
  attempt: number;
  failedAt: string;
  reason: string;
}

// ─── Forecast Events ────────────────────────────────────────────────────────

export interface ForecastCompletedPayload {
  forecastRunId: string;
  warehouseId: string;
  skuCount: number;
  horizonDays: number;
}

// ─── Agent Events ───────────────────────────────────────────────────────────

export interface AgentExecutionCompletedPayload {
  agentExecutionId: string;
  conversationId: string;
  toolsUsed: string[];
  success: boolean;
  durationMs: number;
}

// ─── Event Type Registry ────────────────────────────────────────────────────

/**
 * All domain event types and their corresponding payload types.
 * Used for type-safe event publishing and consumption.
 */
export interface DomainEventMap {
  OrderCreated: OrderCreatedPayload;
  OrderUpdated: OrderUpdatedPayload;
  OrderCanceled: OrderCanceledPayload;
  OrderConfirmed: OrderConfirmedPayload;
  OrderPendingStock: OrderPendingStockPayload;
  StockReceived: StockReceivedPayload;
  StockReserved: StockReservationPayload;
  StockReleased: StockReservationPayload;
  InventoryReserved: InventoryReservedPayload;
  InventoryAdjusted: InventoryAdjustedPayload;
  StockIssued: StockMovementPayload;
  ShipmentCreated: ShipmentLifecyclePayload;
  ShipmentPicking: ShipmentLifecyclePayload;
  ShipmentReadyToShip: ShipmentLifecyclePayload;
  ShipmentDispatched: ShipmentLifecyclePayload;
  ShipmentDelivered: ShipmentLifecyclePayload;
  ShipmentDeliveryFailed: ShipmentLifecyclePayload;
  ShipmentCanceled: ShipmentLifecyclePayload;
  ShipmentCancelRejected: ShipmentLifecyclePayload;
  ShipmentReady: ShipmentReadyPayload;
  TripPlanned: TripPlannedPayload;
  RouteOptimized: RouteOptimizedPayload;
  RouteApproved: RouteApprovedPayload;
  TripDispatched: TripDispatchedPayload;
  DeliveryCompleted: DeliveryCompletedPayload;
  DeliveryFailed: DeliveryFailedPayload;
  ForecastCompleted: ForecastCompletedPayload;
  AgentExecutionCompleted: AgentExecutionCompletedPayload;
}

export type DomainEventType = keyof DomainEventMap;
