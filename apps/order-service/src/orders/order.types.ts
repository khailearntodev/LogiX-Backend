import type {
  AddressSnapshot,
  CustomerSnapshot,
  WarehouseSnapshot,
} from '@logix/messaging';
import type { OrderStatus } from './domain/order-status.js';

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

/** Decimals are strings so Decimal(18,3) / Decimal(18,6) survive JSON. */
export interface OrderTotalsView {
  totalQuantity: string;
  totalWeight: string;
  totalVolume: string;
}

export interface OrderSummaryView extends OrderTotalsView {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  customerId: string;
  customerCode: string;
  customerName: string;
  warehouseId: string;
  warehouseCode: string;
  warehouseName: string;
  currency: string;
  createdAt: Date;
  updatedAt: Date;
  pendingSince: Date | null;
  cancellationRequestedAt: Date | null;
  version: number;
}

export interface OrderLineView {
  id: string;
  lineNumber: number;
  productId: string;
  skuSnapshot: string;
  productNameSnapshot: string;
  unitSnapshot: string;
  quantity: string;
  unitWeight: string;
  unitVolume: string;
}

export interface OrderDetailView extends OrderSummaryView {
  deliveryAddressId: string;
  orderSource: string;
  customerSnapshot: CustomerSnapshot;
  deliveryAddressSnapshot: AddressSnapshot;
  warehouseSnapshot: WarehouseSnapshot;
  confirmedAt: Date | null;
  reservationGroupId: string | null;
  canceledAt: Date | null;
  cancelReason: string | null;
  lines: OrderLineView[];
}

export interface OrderHistoryView {
  id: string;
  fromStatus: OrderStatus | null;
  toStatus: OrderStatus;
  reason: string | null;
  actorId: string | null;
  correlationId: string;
  orderVersion: number;
  occurredAt: Date;
}

/** Authenticated caller plus request metadata needed by command handlers. */
export interface OrderCommandContext {
  tenantId: string;
  actorId: string;
  correlationId: string;
  authorization: string;
}

export interface CreateOrderResult {
  order: OrderDetailView;
  replayed: boolean;
}
