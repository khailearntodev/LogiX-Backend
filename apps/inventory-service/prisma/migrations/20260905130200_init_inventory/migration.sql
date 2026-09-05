-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "inventory";

-- CreateTable
CREATE TABLE "inventory_balances" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "on_hand_quantity" DECIMAL(18,3) NOT NULL,
    "reserved_quantity" DECIMAL(18,3) NOT NULL,
    "available_quantity" DECIMAL(18,3) GENERATED ALWAYS AS ("on_hand_quantity" - "reserved_quantity") STORED,
    "low_stock_threshold" DECIMAL(18,3) NOT NULL,
    "version" BIGINT NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "inventory_balances_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_balances_on_hand" CHECK ("on_hand_quantity" >= 0),
    CONSTRAINT "ck_balances_reserved" CHECK ("reserved_quantity" >= 0),
    CONSTRAINT "ck_balances_available" CHECK ("on_hand_quantity" >= "reserved_quantity"),
    CONSTRAINT "ck_balances_low_stock_threshold" CHECK ("low_stock_threshold" >= 0)
);

-- CreateTable
CREATE TABLE "reservation_groups" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "idempotency_key" VARCHAR(100) NOT NULL,
    "order_version" BIGINT NOT NULL,
    "reserved_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "released_at" TIMESTAMPTZ(6),
    "issued_at" TIMESTAMPTZ(6),
    "version" BIGINT NOT NULL DEFAULT 1,

    CONSTRAINT "reservation_groups_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_reservation_groups_status" CHECK ("status" IN ('ACTIVE', 'RELEASED', 'ISSUED'))
);

-- CreateTable
CREATE TABLE "inventory_reservations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "reservation_group_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "order_line_id" UUID NOT NULL,
    "balance_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "quantity" DECIMAL(18,3) NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "released_at" TIMESTAMPTZ(6),
    "issued_at" TIMESTAMPTZ(6),

    CONSTRAINT "inventory_reservations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_inventory_reservations_quantity" CHECK ("quantity" > 0)
);

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "balance_id" UUID NOT NULL,
    "movement_type" VARCHAR(30) NOT NULL,
    "quantity_delta" DECIMAL(18,3) NOT NULL,
    "before_on_hand" DECIMAL(18,3) NOT NULL,
    "after_on_hand" DECIMAL(18,3) NOT NULL,
    "reference_type" VARCHAR(50) NOT NULL,
    "reference_id" UUID NOT NULL,
    "idempotency_key" VARCHAR(100) NOT NULL,
    "reason" TEXT,
    "actor_id" UUID,
    "correlation_id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_stock_movements_type" CHECK ("movement_type" IN ('RECEIPT', 'ISSUE', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'REVERSAL')),
    CONSTRAINT "ck_stock_movements_quantity_delta" CHECK ("quantity_delta" <> 0),
    CONSTRAINT "ck_stock_movements_after_on_hand" CHECK ("after_on_hand" >= 0),
    CONSTRAINT "ck_stock_movements_adjustment_reason" CHECK ("movement_type" NOT LIKE 'ADJUSTMENT%' OR "reason" IS NOT NULL)
);

-- CreateTable
CREATE TABLE "stock_receipts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "receipt_number" VARCHAR(50) NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "idempotency_key" VARCHAR(100) NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL,
    "actor_id" UUID,
    "correlation_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "version" BIGINT NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "stock_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_receipt_lines" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "receipt_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "quantity" DECIMAL(18,3) NOT NULL,
    "movement_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_receipt_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ix_balances_product_warehouse" ON "inventory_balances"("tenant_id", "product_id", "warehouse_id");

-- CreateIndex
CREATE UNIQUE INDEX "ux_balances_warehouse_product" ON "inventory_balances"("tenant_id", "warehouse_id", "product_id");

-- CreateIndex
CREATE INDEX "ix_balances_low_stock" ON "inventory_balances"("tenant_id", "warehouse_id", "available_quantity") WHERE "available_quantity" <= "low_stock_threshold";

-- CreateIndex
CREATE INDEX "ix_reservation_status_age" ON "reservation_groups"("tenant_id", "status", "reserved_at");

-- CreateIndex
CREATE UNIQUE INDEX "ux_reservation_idempotency" ON "reservation_groups"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "ux_reservation_order_active" ON "reservation_groups"("tenant_id", "order_id") WHERE "status" = 'ACTIVE';

-- CreateIndex
CREATE INDEX "ix_reservations_group" ON "inventory_reservations"("tenant_id", "reservation_group_id");

-- CreateIndex
CREATE INDEX "ix_reservations_order" ON "inventory_reservations"("tenant_id", "order_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ux_inventory_reservations_line" ON "inventory_reservations"("tenant_id", "reservation_group_id", "order_line_id");

-- CreateIndex
CREATE INDEX "ix_reservations_balance_active" ON "inventory_reservations"("tenant_id", "balance_id", "created_at") WHERE "status" = 'ACTIVE';

-- CreateIndex
CREATE INDEX "ix_stock_movement_balance_time" ON "stock_movements"("tenant_id", "warehouse_id", "product_id", "occurred_at" DESC, "id");

-- CreateIndex
CREATE INDEX "ix_stock_movement_reference" ON "stock_movements"("tenant_id", "reference_type", "reference_id");

-- CreateIndex
CREATE INDEX "ix_stock_movement_correlation" ON "stock_movements"("tenant_id", "correlation_id");

-- CreateIndex
CREATE UNIQUE INDEX "ux_stock_movement_idempotency" ON "stock_movements"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "ix_receipts_warehouse_time" ON "stock_receipts"("tenant_id", "warehouse_id", "received_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "ux_receipts_tenant_number" ON "stock_receipts"("tenant_id", "receipt_number");

-- CreateIndex
CREATE UNIQUE INDEX "ux_receipts_idempotency" ON "stock_receipts"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "ux_receipt_lines_movement" ON "stock_receipt_lines"("movement_id");

-- CreateIndex
CREATE INDEX "ix_receipt_lines_receipt" ON "stock_receipt_lines"("tenant_id", "receipt_id");

-- AddForeignKey
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_reservation_group_id_fkey" FOREIGN KEY ("reservation_group_id") REFERENCES "reservation_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_balance_id_fkey" FOREIGN KEY ("balance_id") REFERENCES "inventory_balances"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_balance_id_fkey" FOREIGN KEY ("balance_id") REFERENCES "inventory_balances"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_receipt_lines" ADD CONSTRAINT "stock_receipt_lines_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "stock_receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_receipt_lines" ADD CONSTRAINT "stock_receipt_lines_movement_id_fkey" FOREIGN KEY ("movement_id") REFERENCES "stock_movements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
