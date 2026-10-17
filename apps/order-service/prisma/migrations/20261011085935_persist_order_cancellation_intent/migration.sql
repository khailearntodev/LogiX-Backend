-- AlterTable
ALTER TABLE "sales_orders" ADD COLUMN     "cancellation_actor_id" UUID,
ADD COLUMN     "cancellation_correlation_id" UUID,
ADD COLUMN     "cancellation_reason" TEXT,
ADD COLUMN     "cancellation_requested_at" TIMESTAMPTZ(6);
