ALTER TABLE "inventory_balances"
    ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN "deleted_at" TIMESTAMPTZ(6);

ALTER TABLE "reservation_groups"
    ADD COLUMN "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN "deleted_at" TIMESTAMPTZ(6);

ALTER TABLE "inventory_reservations"
    ADD COLUMN "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN "version" BIGINT NOT NULL DEFAULT 1,
    ADD COLUMN "deleted_at" TIMESTAMPTZ(6);

ALTER TABLE "stock_movements"
    ADD COLUMN "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN "version" BIGINT NOT NULL DEFAULT 1,
    ADD COLUMN "deleted_at" TIMESTAMPTZ(6);

ALTER TABLE "stock_receipts"
    ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "stock_receipt_lines"
    ADD COLUMN "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN "version" BIGINT NOT NULL DEFAULT 1,
    ADD COLUMN "deleted_at" TIMESTAMPTZ(6);

CREATE TABLE "outbox_events" (
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
    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ix_outbox_pending" ON "outbox_events"("next_attempt_at", "occurred_at") WHERE "published_at" IS NULL AND "deleted_at" IS NULL;
CREATE INDEX "ix_outbox_aggregate" ON "outbox_events"("tenant_id", "aggregate_type", "aggregate_id", "aggregate_version");

CREATE TABLE "inbox_events" (
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

CREATE UNIQUE INDEX "ux_inbox_consumer_event" ON "inbox_events"("consumer_name", "event_id");
CREATE INDEX "ix_inbox_tenant_event" ON "inbox_events"("tenant_id", "event_id");
CREATE INDEX "ix_inbox_aggregate_version" ON "inbox_events"("tenant_id", "aggregate_id", "aggregate_version");
