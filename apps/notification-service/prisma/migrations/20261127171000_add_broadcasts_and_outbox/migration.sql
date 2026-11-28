CREATE TABLE "notification"."notification_broadcasts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "notification_id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "idempotency_key" UUID NOT NULL,
    "payload_hash" VARCHAR(64) NOT NULL,
    "audience" JSONB NOT NULL,
    "status" VARCHAR(30) NOT NULL,
    "requested_count" INTEGER,
    "resolved_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "version" BIGINT NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(6),
    CONSTRAINT "notification_broadcasts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_notification_broadcast_status" CHECK ("status" IN ('QUEUED', 'FANOUTING', 'READY', 'COMPLETED', 'PARTIAL_FAILED', 'FAILED'))
);

CREATE UNIQUE INDEX "ux_notification_broadcasts_notification"
    ON "notification"."notification_broadcasts"("notification_id");
CREATE UNIQUE INDEX "ux_notification_broadcasts_idempotency"
    ON "notification"."notification_broadcasts"("tenant_id", "idempotency_key");
CREATE INDEX "ix_notification_broadcasts_tenant_created"
    ON "notification"."notification_broadcasts"("tenant_id", "created_at" DESC, "id" DESC);
CREATE INDEX "ix_notification_broadcasts_status"
    ON "notification"."notification_broadcasts"("status", "updated_at");

ALTER TABLE "notification"."notification_broadcasts"
    ADD CONSTRAINT "notification_broadcasts_notification_id_fkey"
    FOREIGN KEY ("notification_id") REFERENCES "notification"."notifications"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "notification"."outbox_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "topic" VARCHAR(150) NOT NULL,
    "aggregate_type" VARCHAR(100) NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "aggregate_version" BIGINT NOT NULL DEFAULT 1,
    "event_type" VARCHAR(150) NOT NULL,
    "event_version" INTEGER NOT NULL,
    "correlation_id" UUID NOT NULL,
    "causation_id" UUID,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(6),
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_by" VARCHAR(100),
    "locked_until" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" BIGINT NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(6),
    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ix_notification_outbox_aggregate"
    ON "notification"."outbox_events"("tenant_id", "aggregate_type", "aggregate_id", "aggregate_version");
CREATE INDEX "ix_notification_outbox_pending"
    ON "notification"."outbox_events"("next_attempt_at", "occurred_at", "id")
    WHERE "published_at" IS NULL AND "deleted_at" IS NULL;

CREATE INDEX "ix_recipient_read"
    ON "notification"."notification_recipients"("tenant_id", "notification_id")
    WHERE "read_at" IS NOT NULL AND "deleted_at" IS NULL;
