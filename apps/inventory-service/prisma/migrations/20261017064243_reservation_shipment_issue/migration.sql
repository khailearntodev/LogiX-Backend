-- AlterTable
ALTER TABLE "reservation_groups" ADD COLUMN     "issue_request_id" UUID,
ADD COLUMN     "issue_shipment_id" UUID;
