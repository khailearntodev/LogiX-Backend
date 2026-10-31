-- CreateIndex
CREATE INDEX "ix_trips_driver_history" ON "delivery_trips"("tenant_id", "driver_id");
