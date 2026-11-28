-- Create identity.outbox_events table for durable transactional outbox publishing
CREATE TABLE IF NOT EXISTS "identity"."outbox_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "event_type" VARCHAR(100) NOT NULL,
    "event_version" INTEGER NOT NULL,
    "aggregate_type" VARCHAR(100) NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "aggregate_version" BIGINT NOT NULL,
    "correlation_id" UUID NOT NULL,
    "causation_id" UUID,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "published_at" TIMESTAMPTZ(6),
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" BIGINT NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_identity_outbox_event_version" CHECK ("event_version" > 0),
    CONSTRAINT "ck_identity_outbox_aggregate_version" CHECK ("aggregate_version" > 0),
    CONSTRAINT "ck_identity_outbox_attempt_count" CHECK ("attempt_count" >= 0)
);

CREATE INDEX IF NOT EXISTS "ix_outbox_aggregate"
    ON "identity"."outbox_events"("tenant_id", "aggregate_type", "aggregate_id", "aggregate_version");

CREATE INDEX IF NOT EXISTS "ix_outbox_pending"
    ON "identity"."outbox_events"("next_attempt_at", "occurred_at")
    WHERE "published_at" IS NULL AND "deleted_at" IS NULL;
