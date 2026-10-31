-- CreateTable
CREATE TABLE "order_dispatch_batches" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "decision" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_dispatch_batches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ux_order_dispatch_batch_request" ON "order_dispatch_batches"("tenant_id", "id");
