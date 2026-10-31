-- AlterTable
ALTER TABLE "trip_dispatches" ADD COLUMN     "attempt_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "command" JSONB,
ADD COLUMN     "last_error" VARCHAR(100),
ADD COLUMN     "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "payload" JSONB,
ADD COLUMN     "payload_hash" VARCHAR(64),
ADD COLUMN     "receipt" JSONB,
ADD COLUMN     "result" JSONB,
ADD COLUMN     "stage" VARCHAR(30) NOT NULL DEFAULT 'ACCEPTED';

-- CreateIndex
CREATE INDEX "ix_trip_dispatch_recovery" ON "trip_dispatches"("status", "next_attempt_at");
