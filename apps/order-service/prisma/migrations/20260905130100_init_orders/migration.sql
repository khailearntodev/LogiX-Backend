-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "orders";

-- CreateTable
CREATE TABLE "sales_orders" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "order_number" VARCHAR(50) NOT NULL,
    "customer_id" UUID NOT NULL,
    "delivery_address_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" VARCHAR(30) NOT NULL,
    "order_source" VARCHAR(30) NOT NULL,
    "external_channel" VARCHAR(50),
    "external_order_id" VARCHAR(100),
    "idempotency_key" VARCHAR(100),
    "total_quantity" DECIMAL(18,3) NOT NULL,
    "total_weight" DECIMAL(18,3) NOT NULL,
    "total_volume" DECIMAL(18,6) NOT NULL,
    "confirmed_at" TIMESTAMPTZ(6),
    "canceled_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "cancel_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "version" BIGINT NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "sales_orders_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_sales_orders_status" CHECK ("status" IN ('DRAFT', 'PENDING_STOCK', 'CONFIRMED', 'PICKING', 'READY_TO_SHIP', 'IN_DELIVERY', 'DELIVERY_FAILED', 'COMPLETED', 'CANCELED'))
);

-- CreateTable
CREATE TABLE "order_lines" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "line_number" INTEGER NOT NULL,
    "product_id" UUID NOT NULL,
    "sku_snapshot" VARCHAR(100) NOT NULL,
    "product_name_snapshot" VARCHAR(200) NOT NULL,
    "unit_snapshot" VARCHAR(30) NOT NULL,
    "quantity" DECIMAL(18,3) NOT NULL,
    "unit_weight" DECIMAL(18,3) NOT NULL,
    "unit_volume" DECIMAL(18,6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "order_lines_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_order_lines_quantity" CHECK ("quantity" > 0),
    CONSTRAINT "ck_order_lines_unit_weight" CHECK ("unit_weight" >= 0),
    CONSTRAINT "ck_order_lines_unit_volume" CHECK ("unit_volume" >= 0)
);

-- CreateTable
CREATE TABLE "order_status_history" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "from_status" VARCHAR(30),
    "to_status" VARCHAR(30) NOT NULL,
    "reason" TEXT,
    "actor_id" UUID,
    "correlation_id" UUID NOT NULL,
    "order_version" BIGINT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_shortages" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "required_quantity" DECIMAL(18,3) NOT NULL,
    "available_quantity" DECIMAL(18,3) NOT NULL,
    "shortage_hash" VARCHAR(64) NOT NULL,
    "detected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(6),

    CONSTRAINT "order_shortages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ix_orders_tenant_status_created" ON "sales_orders"("tenant_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ix_orders_customer_created" ON "sales_orders"("tenant_id", "customer_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ix_orders_warehouse_status" ON "sales_orders"("tenant_id", "warehouse_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ux_orders_tenant_number" ON "sales_orders"("tenant_id", "order_number");

-- CreateIndex
CREATE UNIQUE INDEX "ux_orders_tenant_idempotency" ON "sales_orders"("tenant_id", "idempotency_key") WHERE "idempotency_key" IS NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "ux_orders_external_source" ON "sales_orders"("tenant_id", "external_channel", "external_order_id") WHERE "external_order_id" IS NOT NULL;

-- CreateIndex
CREATE INDEX "ix_orders_pending_fifo" ON "sales_orders"("tenant_id", "warehouse_id", "confirmed_at", "id") WHERE "status" = 'PENDING_STOCK';

-- CreateIndex
CREATE INDEX "ix_orders_active_updated" ON "sales_orders"("tenant_id", "updated_at" DESC) WHERE "status" NOT IN ('COMPLETED', 'CANCELED');

-- CreateIndex
CREATE INDEX "ix_order_lines_order" ON "order_lines"("tenant_id", "order_id", "line_number");

-- CreateIndex
CREATE UNIQUE INDEX "ux_order_lines_number" ON "order_lines"("tenant_id", "order_id", "line_number");

-- CreateIndex
CREATE UNIQUE INDEX "ux_order_lines_product" ON "order_lines"("tenant_id", "order_id", "product_id");

-- CreateIndex
CREATE INDEX "ix_order_history_timeline" ON "order_status_history"("tenant_id", "order_id", "occurred_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ux_order_history_version" ON "order_status_history"("tenant_id", "order_id", "order_version");

-- CreateIndex
CREATE UNIQUE INDEX "ux_open_order_shortage" ON "order_shortages"("tenant_id", "order_id", "product_id") WHERE "resolved_at" IS NULL;

-- CreateIndex
CREATE INDEX "ix_shortage_retry_lookup" ON "order_shortages"("tenant_id", "warehouse_id", "product_id", "detected_at") WHERE "resolved_at" IS NULL;

-- AddForeignKey
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_shortages" ADD CONSTRAINT "order_shortages_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
