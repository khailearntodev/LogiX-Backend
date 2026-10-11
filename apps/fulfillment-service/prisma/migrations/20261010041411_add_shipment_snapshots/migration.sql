/*
  Warnings:

  - Added the required column `product_name_snapshot` to the `shipment_items` table without a default value. This is not possible if the table is not empty.
  - Added the required column `unit_snapshot` to the `shipment_items` table without a default value. This is not possible if the table is not empty.
  - Added the required column `customer_snapshot` to the `shipments` table without a default value. This is not possible if the table is not empty.
  - Added the required column `delivery_address_snapshot` to the `shipments` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "shipment_items" ADD COLUMN     "product_name_snapshot" VARCHAR(200) NOT NULL,
ADD COLUMN     "unit_snapshot" VARCHAR(30) NOT NULL;

-- AlterTable
ALTER TABLE "shipments" ADD COLUMN     "customer_snapshot" JSONB NOT NULL,
ADD COLUMN     "delivery_address_snapshot" JSONB NOT NULL,
ADD COLUMN     "issuer_snapshot" JSONB;

-- Manual: snapshots must be JSON objects
ALTER TABLE "shipments"
  ADD CONSTRAINT "ck_shipments_customer_snapshot" CHECK (jsonb_typeof("customer_snapshot") = 'object'),
  ADD CONSTRAINT "ck_shipments_delivery_address_snapshot" CHECK (jsonb_typeof("delivery_address_snapshot") = 'object'),
  ADD CONSTRAINT "ck_shipments_issuer_snapshot" CHECK ("issuer_snapshot" IS NULL OR jsonb_typeof("issuer_snapshot") = 'object');
