BEGIN;
SET LOCAL search_path TO inventory;
-- CreateIndex
CREATE UNIQUE INDEX "ux_reservation_issue_shipment" ON "reservation_groups"("tenant_id", "issue_shipment_id");
ALTER TABLE reservation_groups ADD CONSTRAINT ck_reservation_issue_receipt CHECK (
  (issue_shipment_id IS NULL AND issue_request_id IS NULL) OR
  (issue_shipment_id IS NOT NULL AND issue_request_id IS NOT NULL AND status='ISSUED' AND issued_at IS NOT NULL)
);
COMMIT;
