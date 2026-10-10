-- AlterTable
ALTER TABLE "customer_addresses" ADD COLUMN     "address_type" VARCHAR(20) NOT NULL DEFAULT 'SHIPPING',
ADD COLUMN     "delivery_note" TEXT;

-- CreateTable
CREATE TABLE "suppliers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" VARCHAR(50) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "tax_code" VARCHAR(50),
    "contact_name" VARCHAR(200),
    "phone" VARCHAR(30),
    "email" VARCHAR(320),
    "address_line" TEXT NOT NULL,
    "ward" VARCHAR(100),
    "district" VARCHAR(100),
    "province" VARCHAR(100) NOT NULL,
    "postal_code" VARCHAR(20),
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "status" VARCHAR(20) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" BIGINT NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ix_suppliers_tenant_status_name" ON "suppliers"("tenant_id", "status", "name");

-- CreateIndex
CREATE UNIQUE INDEX "ux_suppliers_tenant_code" ON "suppliers"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "ix_customer_addresses_type" ON "customer_addresses"("tenant_id", "customer_id", "address_type", "status");

-- Manual: address type domain
ALTER TABLE "customer_addresses"
  ADD CONSTRAINT "ck_customer_addresses_address_type" CHECK ("address_type" IN ('SHIPPING', 'BILLING'));

-- Manual: one active default address per customer and per address type
DROP INDEX IF EXISTS "ux_customer_default_address";
CREATE UNIQUE INDEX "ux_customer_default_address"
  ON "customer_addresses"("tenant_id", "customer_id", "address_type")
  WHERE "is_default" = true AND "status" = 'ACTIVE';

-- Manual: supplier constraints
ALTER TABLE "suppliers"
  ADD CONSTRAINT "ck_suppliers_latitude" CHECK ("latitude" BETWEEN -90 AND 90),
  ADD CONSTRAINT "ck_suppliers_longitude" CHECK ("longitude" BETWEEN -180 AND 180);

