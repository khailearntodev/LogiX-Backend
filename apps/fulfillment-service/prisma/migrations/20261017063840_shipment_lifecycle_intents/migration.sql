BEGIN;
SET LOCAL search_path TO fulfillment;
-- The former service was a scaffold. Never fabricate immutable snapshots for legacy rows.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM shipments) THEN
    RAISE EXCEPTION 'Shipment lifecycle migration requires an empty shipment pool; backfill verified Order snapshots before retrying';
  END IF;
END $$;
-- AlterTable
ALTER TABLE "shipments" ADD COLUMN     "confirmed_order_version" BIGINT NOT NULL,
ADD COLUMN     "order_number" VARCHAR(50) NOT NULL,
ADD COLUMN     "warehouse_snapshot" JSONB NOT NULL;
ALTER TABLE shipments DROP CONSTRAINT ck_shipments_status;
ALTER TABLE shipments ADD CONSTRAINT ck_shipments_status CHECK
  (status IN ('PENDING_PICK','PICKING','READY_TO_SHIP','DISPATCHED','DELIVERED','FAILED','CANCELED')),
  ADD CONSTRAINT ck_shipments_warehouse_snapshot CHECK (jsonb_typeof(warehouse_snapshot)='object'),
  ADD CONSTRAINT ck_shipments_confirmed_version CHECK (confirmed_order_version > 0);
DROP INDEX fulfillment.ix_shipments_ready_warehouse;
CREATE INDEX ix_shipments_ready_warehouse ON shipments(tenant_id,warehouse_id,ready_at,id) WHERE status='READY_TO_SHIP';

-- CreateTable
CREATE TABLE "shipment_dispatch_intents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "order_version" BIGINT NOT NULL,
    "shipment_version" BIGINT NOT NULL,
    "actor_id" UUID NOT NULL,
    "correlation_id" UUID NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "rejection_reason" VARCHAR(100),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipment_dispatch_intents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipment_order_cursors" (
    "tenant_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "order_version" BIGINT NOT NULL,
    "canceled" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "shipment_order_cursors_pkey" PRIMARY KEY ("tenant_id","order_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shipment_dispatch_intents_shipment_id_key" ON "shipment_dispatch_intents"("shipment_id");

-- CreateIndex
CREATE INDEX "ix_dispatch_intent_recovery" ON "shipment_dispatch_intents"("status", "updated_at");

-- AddForeignKey
ALTER TABLE "shipment_dispatch_intents" ADD CONSTRAINT "shipment_dispatch_intents_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE shipment_dispatch_intents ADD CONSTRAINT ck_dispatch_intent_status
  CHECK (status IN ('PENDING','COMPLETED','REJECTED') AND order_version > 0 AND shipment_version > 0);
CREATE INDEX ix_fulfillment_outbox_pending ON outbox_events(next_attempt_at,occurred_at,id)
  WHERE published_at IS NULL AND deleted_at IS NULL;
COMMIT;
