-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "fulfillment";

-- CreateTable
CREATE TABLE "fulfillment"."shipments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "shipment_number" VARCHAR(50) NOT NULL,
    "order_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "delivery_address_id" UUID NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "total_weight" DECIMAL(18,3) NOT NULL,
    "total_volume" DECIMAL(18,6) NOT NULL,
    "reservation_group_id" UUID NOT NULL,
    "assigned_trip_id" UUID,
    "dispatch_issued_at" TIMESTAMPTZ(6),
    "ready_at" TIMESTAMPTZ(6),
    "delivered_at" TIMESTAMPTZ(6),
    "failed_at" TIMESTAMPTZ(6),
    "failure_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "version" BIGINT NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "shipments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_shipments_status" CHECK ("status" IN ('CREATED', 'READY', 'ASSIGNED', 'IN_TRANSIT', 'FAILED', 'DELIVERED', 'CANCELED'))
);

-- CreateTable
CREATE TABLE "fulfillment"."shipment_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "order_line_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "sku_snapshot" VARCHAR(100) NOT NULL,
    "quantity" DECIMAL(18,3) NOT NULL,
    "weight" DECIMAL(18,3) NOT NULL,
    "volume" DECIMAL(18,6) NOT NULL,

    CONSTRAINT "shipment_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_shipment_items_quantity" CHECK ("quantity" > 0)
);

-- CreateTable
CREATE TABLE "fulfillment"."shipment_status_history" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "from_status" VARCHAR(20),
    "to_status" VARCHAR(20) NOT NULL,
    "reason" TEXT,
    "actor_id" UUID,
    "correlation_id" UUID NOT NULL,
    "shipment_version" BIGINT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipment_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ux_shipments_order" ON "fulfillment"."shipments"("tenant_id", "order_id");
CREATE UNIQUE INDEX "ux_shipments_number" ON "fulfillment"."shipments"("tenant_id", "shipment_number");
CREATE INDEX "ix_shipments_ready_warehouse" ON "fulfillment"."shipments"("tenant_id", "warehouse_id", "ready_at", "id") WHERE "status" = 'READY';
CREATE INDEX "ix_shipments_trip_status" ON "fulfillment"."shipments"("tenant_id", "assigned_trip_id", "status") WHERE "assigned_trip_id" IS NOT NULL;
CREATE INDEX "ix_shipments_order_status" ON "fulfillment"."shipments"("tenant_id", "order_id", "status");
CREATE UNIQUE INDEX "ux_shipment_items_order_line" ON "fulfillment"."shipment_items"("tenant_id", "shipment_id", "order_line_id");
CREATE INDEX "ix_shipment_items_shipment" ON "fulfillment"."shipment_items"("tenant_id", "shipment_id");
CREATE UNIQUE INDEX "ux_shipment_history_version" ON "fulfillment"."shipment_status_history"("tenant_id", "shipment_id", "shipment_version");
CREATE INDEX "ix_shipment_history_timeline" ON "fulfillment"."shipment_status_history"("tenant_id", "shipment_id", "occurred_at", "id");

-- AddForeignKey
ALTER TABLE "fulfillment"."shipment_items" ADD CONSTRAINT "shipment_items_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "fulfillment"."shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fulfillment"."shipment_status_history" ADD CONSTRAINT "shipment_status_history_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "fulfillment"."shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;