BEGIN;

-- AlterTable
ALTER TABLE "orders"."sales_orders" ADD COLUMN     "dispatch_actor_id" UUID,
ADD COLUMN     "dispatch_correlation_id" UUID,
ADD COLUMN     "dispatch_granted_at" TIMESTAMPTZ(6),
ADD COLUMN     "dispatch_order_version" BIGINT,
ADD COLUMN     "dispatch_request_id" UUID,
ADD COLUMN     "dispatch_shipment_id" UUID;
-- All existing rows have NULL dispatch fields. The new unique key cannot collide.
CREATE UNIQUE INDEX "ux_orders_dispatch_request"
ON "orders"."sales_orders"("tenant_id", "dispatch_request_id");

ALTER TABLE "orders"."sales_orders"
ADD CONSTRAINT "ck_orders_dispatch_decision" CHECK (
  (
    dispatch_request_id IS NULL AND dispatch_shipment_id IS NULL
    AND dispatch_order_version IS NULL AND dispatch_granted_at IS NULL
    AND dispatch_actor_id IS NULL AND dispatch_correlation_id IS NULL
  )
  OR (
    dispatch_request_id IS NOT NULL AND dispatch_shipment_id IS NOT NULL
    AND dispatch_order_version IS NOT NULL AND dispatch_order_version > 0
    AND dispatch_granted_at IS NOT NULL AND dispatch_actor_id IS NOT NULL
    AND dispatch_correlation_id IS NOT NULL AND reservation_group_id IS NOT NULL
    AND cancellation_requested_at IS NULL AND canceled_at IS NULL
    AND status IN ('READY_TO_SHIP', 'IN_DELIVERY', 'DELIVERY_FAILED', 'COMPLETED')
  )
);

COMMIT;
