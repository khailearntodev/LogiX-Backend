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
  latitude: string;
  longitude: string;
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

export interface OrderCreatedPayload {
  orderId: string;
  customerId: string;
  warehouseId: string;
  orderLines: Array<{
    productId: string;
    quantity: number;
  }>;
}

export interface OrderConfirmedPayload {
  orderId: string;
  confirmedAt: string;
  customerId: string;
  deliveryAddressId: string;
  warehouseId: string;
  customerSnapshot: CustomerSnapshot;
  deliveryAddressSnapshot: AddressSnapshot;
  warehouseSnapshot: WarehouseSnapshot;
}

export interface OrderPendingStockPayload {
  orderId: string;
  shortageItems: Array<{
    productId: string;
    requestedQuantity: number;
    availableQuantity: number;
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

export type StockReceivedPayload = StockMovementPayload;

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
  OrderConfirmed: OrderConfirmedPayload;
  OrderPendingStock: OrderPendingStockPayload;
  StockReceived: StockReceivedPayload;
  InventoryReserved: InventoryReservedPayload;
  InventoryAdjusted: InventoryAdjustedPayload;
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
