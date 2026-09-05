-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "master_data";

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" VARCHAR(50) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "tax_code" VARCHAR(50),
    "phone" VARCHAR(30),
    "email" VARCHAR(320),
    "status" VARCHAR(20) NOT NULL,
    "disabled_at" TIMESTAMPTZ(6),
    "disabled_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "version" BIGINT NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_addresses" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "label" VARCHAR(100),
    "recipient_name" VARCHAR(200) NOT NULL,
    "phone" VARCHAR(30),
    "address_line" TEXT NOT NULL,
    "ward" VARCHAR(100),
    "district" VARCHAR(100),
    "province" VARCHAR(100) NOT NULL,
    "postal_code" VARCHAR(20),
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "status" VARCHAR(20) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "version" BIGINT NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "customer_addresses_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_customer_addresses_latitude" CHECK ("latitude" BETWEEN -90 AND 90),
    CONSTRAINT "ck_customer_addresses_longitude" CHECK ("longitude" BETWEEN -180 AND 180)
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "sku" VARCHAR(100) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "base_unit" VARCHAR(30) NOT NULL,
    "weight" DECIMAL(18,3) NOT NULL,
    "volume" DECIMAL(18,6) NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "version" BIGINT NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "products_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_products_weight" CHECK ("weight" >= 0),
    CONSTRAINT "ck_products_volume" CHECK ("volume" >= 0)
);

-- CreateTable
CREATE TABLE "warehouses" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" VARCHAR(50) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "address_line" TEXT NOT NULL,
    "ward" VARCHAR(100),
    "district" VARCHAR(100),
    "province" VARCHAR(100) NOT NULL,
    "postal_code" VARCHAR(20),
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "status" VARCHAR(20) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "version" BIGINT NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "warehouses_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_warehouses_latitude" CHECK ("latitude" BETWEEN -90 AND 90),
    CONSTRAINT "ck_warehouses_longitude" CHECK ("longitude" BETWEEN -180 AND 180)
);

-- CreateTable
CREATE TABLE "vehicles" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" VARCHAR(50) NOT NULL,
    "license_plate" VARCHAR(30) NOT NULL,
    "capacity_weight" DECIMAL(18,3) NOT NULL,
    "capacity_volume" DECIMAL(18,6) NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "version" BIGINT NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "vehicles_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_vehicles_capacity_weight" CHECK ("capacity_weight" > 0),
    CONSTRAINT "ck_vehicles_capacity_volume" CHECK ("capacity_volume" > 0)
);

-- CreateTable
CREATE TABLE "drivers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" VARCHAR(50) NOT NULL,
    "user_id" UUID NOT NULL,
    "license_number" VARCHAR(100) NOT NULL,
    "license_expiry" DATE NOT NULL,
    "phone" VARCHAR(30),
    "status" VARCHAR(20) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "version" BIGINT NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "drivers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ix_customers_tenant_status_name" ON "customers"("tenant_id", "status", "name");

-- CreateIndex
CREATE UNIQUE INDEX "ux_customers_tenant_code" ON "customers"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "ix_customer_addresses_customer" ON "customer_addresses"("tenant_id", "customer_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ux_customer_default_address" ON "customer_addresses"("tenant_id", "customer_id") WHERE "is_default" = true AND "status" = 'ACTIVE';

-- CreateIndex
CREATE INDEX "ix_products_tenant_status_name" ON "products"("tenant_id", "status", "name");

-- CreateIndex
CREATE UNIQUE INDEX "ux_products_tenant_sku" ON "products"("tenant_id", "sku");

-- CreateIndex
CREATE INDEX "ix_warehouses_tenant_status" ON "warehouses"("tenant_id", "status", "name");

-- CreateIndex
CREATE UNIQUE INDEX "ux_warehouses_tenant_code" ON "warehouses"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "ux_vehicles_tenant_code" ON "vehicles"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "ux_vehicles_tenant_plate" ON "vehicles"("tenant_id", upper("license_plate"));

-- CreateIndex
CREATE INDEX "ix_vehicles_active_capacity" ON "vehicles"("tenant_id", "capacity_weight", "capacity_volume") WHERE "status" = 'ACTIVE';

-- CreateIndex
CREATE UNIQUE INDEX "ux_drivers_tenant_code" ON "drivers"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "ux_drivers_tenant_user" ON "drivers"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "ux_drivers_tenant_license" ON "drivers"("tenant_id", "license_number");

-- CreateIndex
CREATE INDEX "ix_drivers_active" ON "drivers"("tenant_id", "id") WHERE "status" = 'ACTIVE';

-- AddForeignKey
ALTER TABLE "customer_addresses" ADD CONSTRAINT "customer_addresses_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
