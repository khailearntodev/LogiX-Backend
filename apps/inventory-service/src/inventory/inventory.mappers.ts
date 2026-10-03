import type { InventoryBalance, StockMovement } from '../generated/prisma/client.js';
import type { InventoryBalanceView, StockMovementView } from './inventory.types.js';

/** `availableQuantity` is derived here because the generated column is `@ignore`d. */
export function toBalanceView(row: InventoryBalance): InventoryBalanceView {
  const available = row.onHandQuantity.minus(row.reservedQuantity);

  return {
    id: row.id,
    warehouseId: row.warehouseId,
    productId: row.productId,
    onHandQuantity: row.onHandQuantity.toFixed(3),
    reservedQuantity: row.reservedQuantity.toFixed(3),
    availableQuantity: available.toFixed(3),
    lowStockThreshold: row.lowStockThreshold.toFixed(3),
    isLowStock: available.lessThanOrEqualTo(row.lowStockThreshold),
    updatedAt: row.updatedAt,
  };
}

export function toMovementView(row: StockMovement): StockMovementView {
  return {
    id: row.id,
    warehouseId: row.warehouseId,
    productId: row.productId,
    movementType: row.movementType,
    quantityDelta: row.quantityDelta.toFixed(3),
    beforeOnHand: row.beforeOnHand.toFixed(3),
    afterOnHand: row.afterOnHand.toFixed(3),
    referenceType: row.referenceType,
    referenceId: row.referenceId,
    reason: row.reason,
    actorId: row.actorId,
    occurredAt: row.occurredAt,
  };
}
