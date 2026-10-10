-- AlterTable
ALTER TABLE "stock_receipts" ADD COLUMN     "supplier_id" UUID,
ADD COLUMN     "supplier_snapshot" JSONB;

-- Manual: supplier snapshot is required whenever a supplier is referenced
ALTER TABLE "stock_receipts"
  ADD CONSTRAINT "ck_stock_receipts_supplier_snapshot" CHECK (
    ("supplier_id" IS NULL AND "supplier_snapshot" IS NULL)
    OR ("supplier_id" IS NOT NULL AND jsonb_typeof("supplier_snapshot") = 'object')
  );
