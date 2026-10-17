import { Prisma } from '../../generated/prisma/client.js';

export async function lockOrder(
  tx: Prisma.TransactionClient,
  tenantId: string,
  orderId: string,
): Promise<void> {
  await tx.$queryRaw(Prisma.sql`
    SELECT id FROM orders.sales_orders
    WHERE id = ${orderId}::uuid AND tenant_id = ${tenantId}::uuid
      AND deleted_at IS NULL FOR UPDATE
  `);
}
