UPDATE "notification"."notification_deliveries"
SET "next_attempt_at" = COALESCE("sent_at", "created_at", CURRENT_TIMESTAMP)
WHERE "next_attempt_at" IS NULL;

ALTER TABLE "notification"."notification_deliveries"
    ALTER COLUMN "next_attempt_at" SET DEFAULT CURRENT_TIMESTAMP,
    ALTER COLUMN "next_attempt_at" SET NOT NULL,
    ADD COLUMN "locked_by" VARCHAR(100),
    ADD COLUMN "locked_until" TIMESTAMPTZ(6),
    ADD CONSTRAINT "ck_notification_delivery_status" CHECK ("status" IN ('PENDING', 'PROCESSING', 'RETRY', 'SENT', 'FAILED'));

CREATE INDEX "ix_delivery_lease"
    ON "notification"."notification_deliveries"("locked_until")
    WHERE "status" = 'PROCESSING';
