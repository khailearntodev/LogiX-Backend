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

// ─── Order Events ───────────────────────────────────────────────────────────

export interface OrderCreatedPayload {
  orderId: string;
  customerId: string;
  warehouseId: string;
  orderLines: Array<{
    productId: string;
    quantity: number;
    unitPrice: number;
  }>;
}

export interface OrderConfirmedPayload {
  orderId: string;
  confirmedAt: string;
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

export interface StockReceivedPayload {
  receiptId: string;
  warehouseId: string;
  items: Array<{
    productId: string;
    quantity: number;
  }>;
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

export interface InventoryAdjustedPayload {
  movementId: string;
  warehouseId: string;
  productId: string;
  adjustmentType: string;
  quantity: number;
  reason: string;
}

// ─── Fulfillment Events ─────────────────────────────────────────────────────

export interface ShipmentReadyPayload {
  shipmentId: string;
  orderId: string;
  warehouseId: string;
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
