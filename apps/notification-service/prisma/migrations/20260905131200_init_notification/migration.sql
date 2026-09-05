CREATE SCHEMA IF NOT EXISTS "notification";

CREATE TABLE "notification"."notifications" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "type" VARCHAR(100) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "body" TEXT NOT NULL,
    "severity" VARCHAR(20) NOT NULL,
    "entity_type" VARCHAR(100),
    "entity_id" UUID,
    "source_event_id" UUID,
    "deduplication_key" VARCHAR(100),
    "data" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6),
    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "notification"."notification_recipients" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "notification_id" UUID NOT NULL,
    "recipient_type" VARCHAR(20) NOT NULL,
    "recipient_id" UUID NOT NULL,
    "read_at" TIMESTAMPTZ(6),
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notification_recipients_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_notification_recipient_type" CHECK ("recipient_type" IN ('USER', 'ROLE'))
);

CREATE TABLE "notification"."notification_deliveries" (
    "notification_recipient_id" UUID NOT NULL,
    "channel" VARCHAR(20) NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6),
    "sent_at" TIMESTAMPTZ(6),
    "last_error" TEXT,
    CONSTRAINT "ck_notification_delivery_channel" CHECK ("channel" IN ('IN_APP', 'EMAIL', 'PUSH'))
);

CREATE UNIQUE INDEX "ux_notification_event_recipient_scope" ON "notification"."notifications"("tenant_id", "deduplication_key") WHERE "deduplication_key" IS NOT NULL;
CREATE INDEX "ix_notifications_entity" ON "notification"."notifications"("tenant_id", "entity_type", "entity_id", "created_at" DESC);
CREATE INDEX "ix_notifications_created" ON "notification"."notifications"("tenant_id", "created_at" DESC);
CREATE UNIQUE INDEX "ux_notification_recipient" ON "notification"."notification_recipients"("tenant_id", "notification_id", "recipient_type", "recipient_id");
CREATE INDEX "ix_recipient_unread" ON "notification"."notification_recipients"("tenant_id", "recipient_type", "recipient_id", "created_at" DESC) WHERE "read_at" IS NULL AND "archived_at" IS NULL;
CREATE UNIQUE INDEX "ux_delivery_channel" ON "notification"."notification_deliveries"("notification_recipient_id", "channel");
CREATE INDEX "ix_delivery_retry" ON "notification"."notification_deliveries"("next_attempt_at") WHERE "status" IN ('PENDING', 'RETRY');

ALTER TABLE "notification"."notification_recipients" ADD CONSTRAINT "notification_recipients_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "notification"."notifications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "notification"."notification_deliveries" ADD CONSTRAINT "notification_deliveries_notification_recipient_id_fkey" FOREIGN KEY ("notification_recipient_id") REFERENCES "notification"."notification_recipients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;