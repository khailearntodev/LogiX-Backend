-- AlterTable
ALTER TABLE "delivery_trips" ADD COLUMN     "driver_user_id" UUID,
ADD COLUMN     "driver_version" BIGINT,
ALTER COLUMN "vehicle_id" DROP NOT NULL,
ALTER COLUMN "driver_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "trip_shipments" ADD COLUMN     "claim_receipt" JSONB,
ADD COLUMN     "claim_request" JSONB,
ADD COLUMN     "expected_shipment_version" BIGINT,
ADD COLUMN     "order_id" UUID,
ADD COLUMN     "order_version" BIGINT,
ADD COLUMN     "release_receipt" JSONB,
ADD COLUMN     "release_request" JSONB,
ADD COLUMN     "shipment_snapshot" JSONB,
ADD COLUMN     "shipment_version" BIGINT,
ADD COLUMN     "state" VARCHAR(30) NOT NULL DEFAULT 'ACTIVE';

-- AlterTable
ALTER TABLE "trip_stops" ADD COLUMN     "volume" DECIMAL(18,6),
ADD COLUMN     "weight" DECIMAL(18,3);

-- CreateTable
CREATE TABLE "trip_operations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "trip_id" UUID,
    "request_id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "kind" VARCHAR(30) NOT NULL,
    "status" VARCHAR(30) NOT NULL,
    "payload_hash" VARCHAR(64) NOT NULL,
    "payload" JSONB NOT NULL,
    "result" JSONB,
    "active_lock" VARCHAR(80),
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_until" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" BIGINT NOT NULL DEFAULT 1,

    CONSTRAINT "trip_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trip_cancel_previews" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "version" BIGINT NOT NULL,
    "payload_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trip_cancel_previews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ux_trip_operation_active_lock" ON "trip_operations"("active_lock");

-- CreateIndex
CREATE INDEX "ix_trip_operation_trip" ON "trip_operations"("tenant_id", "trip_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ix_trip_operation_recovery" ON "trip_operations"("status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "ux_trip_operation_request" ON "trip_operations"("tenant_id", "request_id");

-- CreateIndex
CREATE INDEX "ix_trip_cancel_preview" ON "trip_cancel_previews"("tenant_id", "trip_id", "actor_id", "expires_at");
