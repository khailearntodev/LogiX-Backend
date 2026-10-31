-- AlterTable
ALTER TABLE "trip_shipments" ADD COLUMN     "operation_id" UUID;

-- CreateIndex
CREATE INDEX "ix_trip_shipment_operation" ON "trip_shipments"("operation_id");

-- AddForeignKey
ALTER TABLE "trip_shipments" ADD CONSTRAINT "trip_shipments_operation_id_fkey" FOREIGN KEY ("operation_id") REFERENCES "trip_operations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
