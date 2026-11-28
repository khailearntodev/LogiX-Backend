-- Partial indexes specified in docs/architecture/database-design.md §12.1

-- Deduplicate event-sourced ingestion per (source_service, source_event_id)
CREATE UNIQUE INDEX IF NOT EXISTS "ux_audit_source_event"
  ON "audit"."audit_logs" ("source_service", "source_event_id")
  WHERE "source_event_id" IS NOT NULL;

-- Optimize per-tenant queries filtering on failed or denied audit outcomes
CREATE INDEX IF NOT EXISTS "ix_audit_failed"
  ON "audit"."audit_logs" ("tenant_id", "occurred_at" DESC)
  WHERE "outcome" IN ('DENIED', 'FAILED');
