export const MovementType = {
  RECEIPT: 'RECEIPT',
  ISSUE: 'ISSUE',
  ADJUSTMENT_IN: 'ADJUSTMENT_IN',
  ADJUSTMENT_OUT: 'ADJUSTMENT_OUT',
  REVERSAL: 'REVERSAL',
} as const;

export type MovementType = (typeof MovementType)[keyof typeof MovementType];

export const ReferenceType = {
  STOCK_RECEIPT: 'STOCK_RECEIPT',
  MANUAL_ADJUSTMENT: 'MANUAL_ADJUSTMENT',
} as const;

export type ReferenceType = (typeof ReferenceType)[keyof typeof ReferenceType];

export const ReceiptStatus = {
  POSTED: 'POSTED',
} as const;

export const InventoryEventType = {
  STOCK_RECEIVED: 'StockReceived',
  INVENTORY_ADJUSTED: 'InventoryAdjusted',
} as const;

export const INVENTORY_EVENT_VERSION = 1;

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;
