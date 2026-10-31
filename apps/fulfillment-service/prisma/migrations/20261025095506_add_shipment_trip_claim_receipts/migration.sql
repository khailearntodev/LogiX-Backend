-- AlterTable
ALTER TABLE "shipments" ADD COLUMN     "trip_claim_id" UUID;

-- CreateTable
CREATE TABLE "shipment_trip_receipts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "claim_id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "operation" VARCHAR(10) NOT NULL,
    "request_payload" JSONB NOT NULL,
    "response_payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipment_trip_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ix_shipment_trip_receipts_claim" ON "shipment_trip_receipts"("tenant_id", "shipment_id", "claim_id");

-- CreateIndex
CREATE UNIQUE INDEX "ux_shipment_trip_receipts_request" ON "shipment_trip_receipts"("tenant_id", "request_id");

-- AddForeignKey
ALTER TABLE "shipment_trip_receipts" ADD CONSTRAINT "shipment_trip_receipts_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
