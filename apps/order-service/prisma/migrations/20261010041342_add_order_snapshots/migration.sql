/*
  Warnings:

  - Added the required column `customer_snapshot` to the `sales_orders` table without a default value. This is not possible if the table is not empty.
  - Added the required column `delivery_address_snapshot` to the `sales_orders` table without a default value. This is not possible if the table is not empty.
  - Added the required column `warehouse_snapshot` to the `sales_orders` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "sales_orders" ADD COLUMN     "billing_address_snapshot" JSONB,
ADD COLUMN     "customer_snapshot" JSONB NOT NULL,
ADD COLUMN     "delivery_address_snapshot" JSONB NOT NULL,
ADD COLUMN     "warehouse_snapshot" JSONB NOT NULL;

-- Manual: snapshots must be JSON objects
ALTER TABLE "sales_orders"
  ADD CONSTRAINT "ck_sales_orders_customer_snapshot" CHECK (jsonb_typeof("customer_snapshot") = 'object'),
  ADD CONSTRAINT "ck_sales_orders_delivery_address_snapshot" CHECK (jsonb_typeof("delivery_address_snapshot") = 'object'),
  ADD CONSTRAINT "ck_sales_orders_warehouse_snapshot" CHECK (jsonb_typeof("warehouse_snapshot") = 'object'),
  ADD CONSTRAINT "ck_sales_orders_billing_address_snapshot" CHECK ("billing_address_snapshot" IS NULL OR jsonb_typeof("billing_address_snapshot") = 'object');
