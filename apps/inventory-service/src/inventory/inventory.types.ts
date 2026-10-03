/** Quantities cross the API boundary as strings to preserve Decimal(18,3) precision. */
export interface InventoryBalanceView {
  id: string;
  warehouseId: string;
  productId: string;
  onHandQuantity: string;
  reservedQuantity: string;
  availableQuantity: string;
  lowStockThreshold: string;
  isLowStock: boolean;
  updatedAt: Date;
}

export interface StockMovementView {
  id: string;
  warehouseId: string;
  productId: string;
  movementType: string;
  quantityDelta: string;
  beforeOnHand: string;
  afterOnHand: string;
  referenceType: string;
  referenceId: string;
  reason: string | null;
  actorId: string | null;
  occurredAt: Date;
}

export interface StockReceiptView {
  id: string;
  receiptNumber: string;
  warehouseId: string;
  status: string;
  receivedAt: Date;
  lines: Array<{
    id: string;
    productId: string;
    quantity: string;
    movementId: string;
  }>;
}

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}
