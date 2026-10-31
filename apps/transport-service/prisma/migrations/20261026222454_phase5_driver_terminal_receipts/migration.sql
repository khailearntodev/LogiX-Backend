-- AlterTable
ALTER TABLE "delivery_attempts" ADD COLUMN     "acting_reason" TEXT,
ADD COLUMN     "assignee_user_id" UUID,
ADD COLUMN     "actor_mode" VARCHAR(20),
ADD COLUMN     "actor_user_id" UUID,
ADD COLUMN     "payload_hash" VARCHAR(64),
ADD COLUMN     "receipt" JSONB,
ADD COLUMN     "request_id" UUID;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM transport.delivery_attempts
    GROUP BY tenant_id, trip_stop_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'Driver receipt migration blocked: a stop already has multiple terminal DeliveryAttempt rows';
  END IF;
END
$$;

-- CreateIndex
CREATE UNIQUE INDEX "ux_delivery_attempt_request" ON "delivery_attempts"("tenant_id", "request_id");

-- CreateIndex
CREATE UNIQUE INDEX "ux_delivery_attempt_terminal_stop" ON "delivery_attempts"("tenant_id", "trip_stop_id");

CREATE OR REPLACE FUNCTION transport.reject_delivery_attempt_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'DeliveryAttempt terminal receipts are immutable';
END
$$;

CREATE TRIGGER trg_delivery_attempt_immutable
BEFORE UPDATE ON transport.delivery_attempts
FOR EACH ROW
EXECUTE FUNCTION transport.reject_delivery_attempt_update();
