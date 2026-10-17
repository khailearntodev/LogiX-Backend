import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import {
  ORDER_BUSINESS_TIMEZONE,
  ORDER_NUMBER_PREFIX,
  ORDER_NUMBER_SEQUENCE_DIGITS,
} from '../domain/order-constants.js';

const periodFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: ORDER_BUSINESS_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** YYYYMMDD of `at` in the order business timezone. */
export function formatOrderPeriod(at: Date): string {
  return periodFormatter.format(at).replace(/-/g, '');
}

export function formatOrderNumber(period: string, sequence: bigint): string {
  return `${ORDER_NUMBER_PREFIX}-${period}-${sequence
    .toString()
    .padStart(ORDER_NUMBER_SEQUENCE_DIGITS, '0')}`;
}

/**
 * Allocates gap-tolerant, per-tenant daily order numbers. The upsert takes a
 * row lock on (tenant, period), so concurrent transactions are serialized and
 * never receive the same value.
 */
@Injectable()
export class OrderNumberService {
  async next(
    tx: Prisma.TransactionClient,
    tenantId: string,
    at: Date,
  ): Promise<string> {
    const period = formatOrderPeriod(at);
    const rows = await tx.$queryRaw<Array<{ last_value: bigint }>>`
      INSERT INTO "orders"."order_number_sequences" ("tenant_id", "period", "last_value", "updated_at")
      VALUES (${tenantId}::uuid, ${period}, 1, now())
      ON CONFLICT ("tenant_id", "period")
      DO UPDATE SET "last_value" = "order_number_sequences"."last_value" + 1, "updated_at" = now()
      RETURNING "last_value"
    `;
    const [row] = rows;
    if (!row) {
      throw new Error('Order number sequence upsert returned no row');
    }
    return formatOrderNumber(period, BigInt(row.last_value));
  }
}
