ALTER TABLE "audit"."audit_logs"
    ADD COLUMN "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN "version" BIGINT NOT NULL DEFAULT 1,
    ADD COLUMN "deleted_at" TIMESTAMPTZ(6);

CREATE TABLE "audit"."inbox_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "consumer_name" VARCHAR(100) NOT NULL,
    "event_type" VARCHAR(100) NOT NULL,
    "aggregate_id" UUID,
    "aggregate_version" BIGINT,
    "processed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "outcome" VARCHAR(30) NOT NULL,
    "error_code" VARCHAR(100),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" BIGINT NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(6),
    CONSTRAINT "inbox_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ux_inbox_consumer_event" ON "audit"."inbox_events"("consumer_name", "event_id");
CREATE INDEX "ix_inbox_tenant_event" ON "audit"."inbox_events"("tenant_id", "event_id");
CREATE INDEX "ix_inbox_aggregate" ON "audit"."inbox_events"("tenant_id", "aggregate_id", "aggregate_version");