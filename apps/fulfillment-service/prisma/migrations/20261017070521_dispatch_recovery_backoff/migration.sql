-- AlterTable
ALTER TABLE "shipment_dispatch_intents" ADD COLUMN     "attempt_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;
