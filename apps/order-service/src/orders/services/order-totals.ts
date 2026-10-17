import { Prisma } from '../../generated/prisma/client.js';

export interface TotalsLineInput {
  quantity: Prisma.Decimal | string;
  unitWeight: Prisma.Decimal | string;
  unitVolume: Prisma.Decimal | string;
}

export interface OrderTotals {
  totalQuantity: Prisma.Decimal;
  totalWeight: Prisma.Decimal;
  totalVolume: Prisma.Decimal;
}

/** Scales of sales_orders.total_* columns; rounding is explicit instead of left to the database. */
const TOTAL_QUANTITY_SCALE = 3;
const TOTAL_WEIGHT_SCALE = 3;
const TOTAL_VOLUME_SCALE = 6;

/**
 * Pure aggregation of line quantities, weights and volumes using arbitrary
 * precision decimals; floating point is never involved.
 */
export function calculateOrderTotals(
  lines: readonly TotalsLineInput[],
): OrderTotals {
  const zero = new Prisma.Decimal(0);
  const raw = lines.reduce<OrderTotals>(
    (acc, line) => {
      const quantity = new Prisma.Decimal(line.quantity);
      return {
        totalQuantity: acc.totalQuantity.plus(quantity),
        totalWeight: acc.totalWeight.plus(quantity.times(line.unitWeight)),
        totalVolume: acc.totalVolume.plus(quantity.times(line.unitVolume)),
      };
    },
    { totalQuantity: zero, totalWeight: zero, totalVolume: zero },
  );
  return {
    totalQuantity: raw.totalQuantity.toDecimalPlaces(
      TOTAL_QUANTITY_SCALE,
      Prisma.Decimal.ROUND_HALF_UP,
    ),
    totalWeight: raw.totalWeight.toDecimalPlaces(
      TOTAL_WEIGHT_SCALE,
      Prisma.Decimal.ROUND_HALF_UP,
    ),
    totalVolume: raw.totalVolume.toDecimalPlaces(
      TOTAL_VOLUME_SCALE,
      Prisma.Decimal.ROUND_HALF_UP,
    ),
  };
}
