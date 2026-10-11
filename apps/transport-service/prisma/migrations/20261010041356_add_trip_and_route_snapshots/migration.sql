/*
  Warnings:

  - Added the required column `depot_snapshot` to the `delivery_trips` table without a default value. This is not possible if the table is not empty.
  - Added the required column `input_snapshot` to the `route_plans` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "delivery_trips" ADD COLUMN     "depot_snapshot" JSONB NOT NULL,
ADD COLUMN     "driver_snapshot" JSONB,
ADD COLUMN     "vehicle_snapshot" JSONB;

-- AlterTable
ALTER TABLE "route_plans" ADD COLUMN     "input_snapshot" JSONB NOT NULL;

-- Manual: snapshots must be JSON objects
ALTER TABLE "delivery_trips"
  ADD CONSTRAINT "ck_delivery_trips_depot_snapshot" CHECK (jsonb_typeof("depot_snapshot") = 'object'),
  ADD CONSTRAINT "ck_delivery_trips_vehicle_snapshot" CHECK ("vehicle_snapshot" IS NULL OR jsonb_typeof("vehicle_snapshot") = 'object'),
  ADD CONSTRAINT "ck_delivery_trips_driver_snapshot" CHECK ("driver_snapshot" IS NULL OR jsonb_typeof("driver_snapshot") = 'object');

ALTER TABLE "route_plans"
  ADD CONSTRAINT "ck_route_plans_input_snapshot" CHECK (jsonb_typeof("input_snapshot") = 'object');

ALTER TABLE "trip_stops"
  ADD CONSTRAINT "ck_trip_stops_address_snapshot" CHECK (jsonb_typeof("address_snapshot") = 'object');
