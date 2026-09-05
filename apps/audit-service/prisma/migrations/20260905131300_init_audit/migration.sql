CREATE SCHEMA IF NOT EXISTS "audit";

CREATE TABLE "audit"."audit_logs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "actor_id" UUID,
    "actor_type" VARCHAR(30) NOT NULL,
    "action" VARCHAR(100) NOT NULL,
    "entity_type" VARCHAR(100) NOT NULL,
    "entity_id" UUID,
    "outcome" VARCHAR(30) NOT NULL,
    "before_data" JSONB,
    "after_data" JSONB,
    "metadata" JSONB NOT NULL,
    "correlation_id" UUID NOT NULL,
    "causation_id" UUID,
    "source_service" VARCHAR(100) NOT NULL,
    "source_event_id" UUID,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "ingested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_audit_actor_type" CHECK ("actor_type" IN ('USER', 'SYSTEM', 'AGENT')),
    CONSTRAINT "ck_audit_outcome" CHECK ("outcome" IN ('SUCCESS', 'DENIED', 'FAILED'))
);

CREATE UNIQUE INDEX "ux_audit_source_event" ON "audit"."audit_logs"("source_service", "source_event_id") WHERE "source_event_id" IS NOT NULL;
CREATE INDEX "ix_audit_tenant_time" ON "audit"."audit_logs"("tenant_id", "occurred_at" DESC, "id");
CREATE INDEX "ix_audit_actor_time" ON "audit"."audit_logs"("tenant_id", "actor_id", "occurred_at" DESC);
CREATE INDEX "ix_audit_action_time" ON "audit"."audit_logs"("tenant_id", "action", "occurred_at" DESC);
CREATE INDEX "ix_audit_entity_time" ON "audit"."audit_logs"("tenant_id", "entity_type", "entity_id", "occurred_at" DESC);
CREATE INDEX "ix_audit_correlation" ON "audit"."audit_logs"("tenant_id", "correlation_id", "occurred_at");
CREATE INDEX "ix_audit_failed" ON "audit"."audit_logs"("tenant_id", "occurred_at" DESC) WHERE "outcome" IN ('DENIED', 'FAILED');