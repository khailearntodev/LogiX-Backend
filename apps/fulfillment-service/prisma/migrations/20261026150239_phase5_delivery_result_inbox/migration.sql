-- AlterTable
ALTER TABLE "inbox_events" ADD COLUMN     "attempt_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "event_payload" JSONB,
ADD COLUMN     "last_error" VARCHAR(100),
ADD COLUMN     "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "payload_hash" VARCHAR(64),
ADD COLUMN     "semantic_key" VARCHAR(100);

-- CreateIndex
CREATE INDEX "ix_inbox_deferred_retry" ON "inbox_events"("consumer_name", "outcome", "next_attempt_at");

-- CreateIndex
CREATE INDEX "ix_inbox_semantic_result" ON "inbox_events"("tenant_id", "consumer_name", "semantic_key");
