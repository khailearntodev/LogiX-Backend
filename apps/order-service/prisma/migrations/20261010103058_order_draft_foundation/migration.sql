-- AlterTable
ALTER TABLE "sales_orders" ADD COLUMN     "idempotency_request_hash" VARCHAR(64),
ADD COLUMN     "pending_since" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "order_number_sequences" (
    "tenant_id" UUID NOT NULL,
    "period" CHAR(8) NOT NULL,
    "last_value" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_order_number_sequences" PRIMARY KEY ("tenant_id","period")
);

-- Hand-written: constraints and partial indexes Prisma cannot express.

-- An idempotency hash only makes sense together with its key (QĐ-8).
ALTER TABLE "sales_orders"
  ADD CONSTRAINT "ck_sales_orders_idempotency_hash"
  CHECK ("idempotency_request_hash" IS NULL OR ("idempotency_key" IS NOT NULL AND "idempotency_request_hash" ~ '^[0-9a-f]{64}$'));

-- A PENDING_STOCK order must always carry its FIFO anchor (QĐ-4).
ALTER TABLE "sales_orders"
  ADD CONSTRAINT "ck_sales_orders_pending_since"
  CHECK ("status" <> 'PENDING_STOCK' OR "pending_since" IS NOT NULL);

-- Reservation retry queue is ordered by pending_since instead of confirmed_at (QĐ-4).
DROP INDEX "ix_orders_pending_fifo";
CREATE INDEX "ix_orders_pending_fifo" ON "sales_orders"("tenant_id", "warehouse_id", "pending_since", "id") WHERE "status" = 'PENDING_STOCK' AND "deleted_at" IS NULL;

-- Order number sequences: period is a calendar day (YYYYMMDD) and the counter never goes negative (QĐ-7).
ALTER TABLE "order_number_sequences"
  ADD CONSTRAINT "ck_order_number_sequences_period" CHECK ("period" ~ '^[0-9]{8}$'),
  ADD CONSTRAINT "ck_order_number_sequences_last_value" CHECK ("last_value" >= 0);