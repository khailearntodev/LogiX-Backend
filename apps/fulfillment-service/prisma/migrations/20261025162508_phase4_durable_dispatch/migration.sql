-- AlterTable
ALTER TABLE "shipment_dispatch_intents" ADD COLUMN     "batch_id" UUID,
ADD COLUMN     "grant_receipt" JSONB;

-- CreateTable
CREATE TABLE "shipment_dispatch_batches" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "payload_hash" VARCHAR(64) NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "stage" VARCHAR(20) NOT NULL,
    "decision" JSONB,
    "response" JSONB,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" VARCHAR(100),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipment_dispatch_batches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ix_shipment_batch_recovery" ON "shipment_dispatch_batches"("status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "ux_shipment_dispatch_batch_request" ON "shipment_dispatch_batches"("tenant_id", "id");
