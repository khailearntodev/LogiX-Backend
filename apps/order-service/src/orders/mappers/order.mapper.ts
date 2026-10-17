import type {
  AddressSnapshot,
  CustomerSnapshot,
  OrderDraftPayload,
  WarehouseSnapshot,
} from '@logix/messaging';
import type {
  OrderLine,
  OrderStatusHistory,
  Prisma,
  SalesOrder,
} from '../../generated/prisma/client.js';
import type { OrderStatus } from '../domain/order-status.js';
import type {
  MasterDataCustomer,
  MasterDataCustomerAddress,
  MasterDataWarehouse,
} from '../integrations/master-data.types.js';
import type {
  OrderDetailView,
  OrderHistoryView,
  OrderLineView,
  OrderSummaryView,
  OrderTotalsView,
} from '../order.types.js';

const QUANTITY_SCALE = 3;
const WEIGHT_SCALE = 3;
const VOLUME_SCALE = 6;

export type SalesOrderWithLines = SalesOrder & { lines: OrderLine[] };

const formatQuantity = (value: Prisma.Decimal): string =>
  value.toFixed(QUANTITY_SCALE);
const formatWeight = (value: Prisma.Decimal): string =>
  value.toFixed(WEIGHT_SCALE);
const formatVolume = (value: Prisma.Decimal): string =>
  value.toFixed(VOLUME_SCALE);

/** Row versions are small monotonic counters, so they always fit a JS number. */
const toVersionNumber = (value: bigint): number => Number(value);

/**
 * Snapshots are written exclusively by this service, but JSON columns are untyped;
 * a non-object value means corrupted data and must surface instead of being masked.
 */
function readSnapshot<T>(value: Prisma.JsonValue, column: string): T {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Corrupted order snapshot column: ${column}`);
  }
  return value as unknown as T;
}

export function buildCustomerSnapshot(
  customer: MasterDataCustomer,
): CustomerSnapshot {
  return {
    customerId: customer.id,
    customerVersion: customer.version,
    code: customer.code,
    name: customer.name,
    taxCode: customer.taxCode,
    phone: customer.phone,
    email: customer.email,
  };
}

export function buildAddressSnapshot(
  address: MasterDataCustomerAddress,
): AddressSnapshot {
  return {
    addressId: address.id,
    addressVersion: address.version,
    addressType: address.addressType as AddressSnapshot['addressType'],
    label: address.label,
    recipientName: address.recipientName,
    phone: address.phone,
    addressLine: address.addressLine,
    ward: address.ward,
    district: address.district,
    province: address.province,
    postalCode: address.postalCode,
    latitude: address.latitude,
    longitude: address.longitude,
    deliveryNote: address.deliveryNote,
  };
}

export function buildWarehouseSnapshot(
  warehouse: MasterDataWarehouse,
): WarehouseSnapshot {
  return {
    warehouseId: warehouse.id,
    warehouseVersion: warehouse.version,
    code: warehouse.code,
    name: warehouse.name,
    addressLine: warehouse.addressLine,
    ward: warehouse.ward,
    district: warehouse.district,
    province: warehouse.province,
    postalCode: warehouse.postalCode,
    latitude: warehouse.latitude,
    longitude: warehouse.longitude,
  };
}

function toTotalsView(order: SalesOrder): OrderTotalsView {
  return {
    totalQuantity: formatQuantity(order.totalQuantity),
    totalWeight: formatWeight(order.totalWeight),
    totalVolume: formatVolume(order.totalVolume),
  };
}

export function toOrderSummaryView(order: SalesOrder): OrderSummaryView {
  const customer = readSnapshot<CustomerSnapshot>(
    order.customerSnapshot,
    'customer_snapshot',
  );
  const warehouse = readSnapshot<WarehouseSnapshot>(
    order.warehouseSnapshot,
    'warehouse_snapshot',
  );
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status as OrderStatus,
    customerId: order.customerId,
    customerCode: customer.code,
    customerName: customer.name,
    warehouseId: order.warehouseId,
    warehouseCode: warehouse.code,
    warehouseName: warehouse.name,
    currency: order.currency,
    ...toTotalsView(order),
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    pendingSince: order.pendingSince,
    cancellationRequestedAt: order.cancellationRequestedAt,
    dispatchGrantedAt: order.dispatchGrantedAt,
    dispatchShipmentId: order.dispatchShipmentId,
    version: toVersionNumber(order.version),
  };
}

export function toOrderLineView(line: OrderLine): OrderLineView {
  return {
    id: line.id,
    lineNumber: line.lineNumber,
    productId: line.productId,
    skuSnapshot: line.skuSnapshot,
    productNameSnapshot: line.productNameSnapshot,
    unitSnapshot: line.unitSnapshot,
    quantity: formatQuantity(line.quantity),
    unitWeight: formatWeight(line.unitWeight),
    unitVolume: formatVolume(line.unitVolume),
  };
}

export function toOrderDetailView(order: SalesOrderWithLines): OrderDetailView {
  return {
    ...toOrderSummaryView(order),
    deliveryAddressId: order.deliveryAddressId,
    orderSource: order.orderSource,
    customerSnapshot: readSnapshot<CustomerSnapshot>(
      order.customerSnapshot,
      'customer_snapshot',
    ),
    deliveryAddressSnapshot: readSnapshot<AddressSnapshot>(
      order.deliveryAddressSnapshot,
      'delivery_address_snapshot',
    ),
    warehouseSnapshot: readSnapshot<WarehouseSnapshot>(
      order.warehouseSnapshot,
      'warehouse_snapshot',
    ),
    confirmedAt: order.confirmedAt,
    reservationGroupId: order.reservationGroupId,
    canceledAt: order.canceledAt,
    cancelReason: order.cancelReason,
    lines: [...order.lines]
      .sort((a, b) => a.lineNumber - b.lineNumber)
      .map(toOrderLineView),
  };
}

export function toOrderHistoryView(
  entry: OrderStatusHistory,
): OrderHistoryView {
  return {
    id: entry.id,
    fromStatus: entry.fromStatus as OrderStatus | null,
    toStatus: entry.toStatus as OrderStatus,
    reason: entry.reason,
    actorId: entry.actorId,
    correlationId: entry.correlationId,
    orderVersion: toVersionNumber(entry.orderVersion),
    occurredAt: entry.occurredAt,
  };
}

export function toOrderDraftPayload(
  order: SalesOrderWithLines,
): OrderDraftPayload {
  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    customerId: order.customerId,
    deliveryAddressId: order.deliveryAddressId,
    warehouseId: order.warehouseId,
    currency: order.currency,
    ...toTotalsView(order),
    orderLines: [...order.lines]
      .sort((a, b) => a.lineNumber - b.lineNumber)
      .map((line) => ({
        lineNumber: line.lineNumber,
        productId: line.productId,
        quantity: formatQuantity(line.quantity),
      })),
  };
}
