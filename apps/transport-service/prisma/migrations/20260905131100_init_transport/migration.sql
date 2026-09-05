CREATE SCHEMA IF NOT EXISTS "transport";

CREATE TABLE "transport"."delivery_trips" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "trip_number" VARCHAR(50) NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "driver_id" UUID NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "planned_start_at" TIMESTAMPTZ(6) NOT NULL,
    "actual_start_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "total_weight" DECIMAL(18,3) NOT NULL,
    "total_volume" DECIMAL(18,6) NOT NULL,
    "approved_route_plan_id" UUID,
    "dispatch_version" BIGINT NOT NULL,
    "dispatched_at" TIMESTAMPTZ(6),
    "canceled_at" TIMESTAMPTZ(6),
    "cancel_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "version" BIGINT NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(6),
    CONSTRAINT "delivery_trips_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_delivery_trips_status" CHECK ("status" IN ('DRAFT', 'PLANNED', 'APPROVED', 'IN_PROGRESS', 'COMPLETED', 'CANCELED'))
);

CREATE TABLE "transport"."trip_shipments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "weight" DECIMAL(18,3) NOT NULL,
    "volume" DECIMAL(18,6) NOT NULL,
    "assigned_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMPTZ(6),
    CONSTRAINT "trip_shipments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "transport"."trip_stops" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "delivery_address_id" UUID NOT NULL,
    "address_snapshot" JSONB NOT NULL,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "planned_sequence" INTEGER NOT NULL,
    "approved_sequence" INTEGER,
    "status" VARCHAR(20) NOT NULL,
    "current_attempt" INTEGER NOT NULL DEFAULT 0,
    "arrived_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "version" BIGINT NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(6),
    CONSTRAINT "trip_stops_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_trip_stops_status" CHECK ("status" IN ('PENDING', 'ARRIVED', 'DELIVERED', 'FAILED')),
    CONSTRAINT "ck_trip_stops_latitude" CHECK ("latitude" IS NULL OR "latitude" BETWEEN -90 AND 90),
    CONSTRAINT "ck_trip_stops_longitude" CHECK ("longitude" IS NULL OR "longitude" BETWEEN -180 AND 180),
    CONSTRAINT "ck_trip_stops_coordinates" CHECK (("latitude" IS NULL) = ("longitude" IS NULL))
);

CREATE TABLE "transport"."route_plans" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "plan_version" BIGINT NOT NULL,
    "route_request_id" UUID NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "source" VARCHAR(30) NOT NULL,
    "input_hash" VARCHAR(64) NOT NULL,
    "solver_name" VARCHAR(100) NOT NULL,
    "solver_version" VARCHAR(50) NOT NULL,
    "objective" VARCHAR(100) NOT NULL,
    "total_distance" DECIMAL(18,3) NOT NULL,
    "estimated_cost" DECIMAL(18,2) NOT NULL,
    "metrics" JSONB NOT NULL,
    "original_plan_id" UUID,
    "override_reason" TEXT,
    "approved_by" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "route_plans_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_route_plans_status" CHECK ("status" IN ('PROPOSED', 'APPROVED', 'SUPERSEDED', 'REJECTED')),
    CONSTRAINT "ck_route_plans_source" CHECK ("source" IN ('OPTIMIZER', 'MANUAL_OVERRIDE')),
    CONSTRAINT "ck_route_plans_manual_override" CHECK ("source" <> 'MANUAL_OVERRIDE' OR ("override_reason" IS NOT NULL AND "original_plan_id" IS NOT NULL))
);

CREATE TABLE "transport"."route_plan_stops" (
    "route_plan_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "trip_stop_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "distance_from_previous" DECIMAL(18,3) NOT NULL,
    "cumulative_distance" DECIMAL(18,3) NOT NULL,
    "estimated_arrival_at" TIMESTAMPTZ(6) NOT NULL
);

CREATE TABLE "transport"."delivery_attempts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "trip_stop_id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "attempt_number" INTEGER NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "reason" TEXT,
    "actor_driver_id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "correlation_id" UUID NOT NULL,
    CONSTRAINT "delivery_attempts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_delivery_attempts_failed_reason" CHECK ("status" <> 'FAILED' OR "reason" IS NOT NULL)
);

CREATE TABLE "transport"."trip_dispatches" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "dispatch_version" BIGINT NOT NULL,
    "idempotency_key" VARCHAR(100) NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "requested_by" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ(6) NOT NULL,
    "completed_at" TIMESTAMPTZ(6),
    "correlation_id" UUID NOT NULL,
    CONSTRAINT "trip_dispatches_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ux_trips_number" ON "transport"."delivery_trips"("tenant_id", "trip_number");
CREATE INDEX "ix_trips_status_schedule" ON "transport"."delivery_trips"("tenant_id", "status", "planned_start_at");
CREATE INDEX "ix_trips_warehouse_status" ON "transport"."delivery_trips"("tenant_id", "warehouse_id", "status", "planned_start_at");
CREATE INDEX "ix_trips_driver_active" ON "transport"."delivery_trips"("tenant_id", "driver_id", "planned_start_at") WHERE "status" IN ('PLANNED', 'APPROVED', 'IN_PROGRESS');
CREATE INDEX "ix_trips_vehicle_active" ON "transport"."delivery_trips"("tenant_id", "vehicle_id", "planned_start_at") WHERE "status" IN ('PLANNED', 'APPROVED', 'IN_PROGRESS');
CREATE UNIQUE INDEX "ux_trip_active_shipment" ON "transport"."trip_shipments"("tenant_id", "shipment_id") WHERE "removed_at" IS NULL;
CREATE INDEX "ix_trip_shipments_trip" ON "transport"."trip_shipments"("tenant_id", "trip_id", "assigned_at") WHERE "removed_at" IS NULL;
CREATE UNIQUE INDEX "ux_trip_stop_shipment" ON "transport"."trip_stops"("tenant_id", "trip_id", "shipment_id");
CREATE UNIQUE INDEX "ux_trip_stop_approved_sequence" ON "transport"."trip_stops"("tenant_id", "trip_id", "approved_sequence") WHERE "approved_sequence" IS NOT NULL;
CREATE INDEX "ix_trip_stops_driver_view" ON "transport"."trip_stops"("tenant_id", "trip_id", "approved_sequence");
CREATE INDEX "ix_trip_stops_status" ON "transport"."trip_stops"("tenant_id", "trip_id", "status");
CREATE UNIQUE INDEX "ux_route_plan_version" ON "transport"."route_plans"("tenant_id", "trip_id", "plan_version");
CREATE UNIQUE INDEX "ux_route_request" ON "transport"."route_plans"("tenant_id", "route_request_id");
CREATE UNIQUE INDEX "ux_route_plan_approved" ON "transport"."route_plans"("tenant_id", "trip_id") WHERE "status" = 'APPROVED';
CREATE INDEX "ix_route_plan_trip_created" ON "transport"."route_plans"("tenant_id", "trip_id", "created_at" DESC);
CREATE INDEX "ix_route_plan_input_hash" ON "transport"."route_plans"("tenant_id", "input_hash", "created_at" DESC);
CREATE UNIQUE INDEX "ux_route_plan_stop_sequence" ON "transport"."route_plan_stops"("tenant_id", "route_plan_id", "sequence");
CREATE UNIQUE INDEX "ux_route_plan_stop_trip_stop" ON "transport"."route_plan_stops"("tenant_id", "route_plan_id", "trip_stop_id");
CREATE UNIQUE INDEX "ux_delivery_attempt_number" ON "transport"."delivery_attempts"("tenant_id", "trip_stop_id", "attempt_number");
CREATE INDEX "ix_delivery_attempt_shipment" ON "transport"."delivery_attempts"("tenant_id", "shipment_id", "attempt_number" DESC);
CREATE UNIQUE INDEX "ux_trip_dispatch_version" ON "transport"."trip_dispatches"("tenant_id", "trip_id", "dispatch_version");
CREATE UNIQUE INDEX "ux_trip_dispatch_key" ON "transport"."trip_dispatches"("tenant_id", "idempotency_key");

ALTER TABLE "transport"."delivery_trips" ADD CONSTRAINT "delivery_trips_approved_route_plan_id_fkey" FOREIGN KEY ("approved_route_plan_id") REFERENCES "transport"."route_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "transport"."trip_shipments" ADD CONSTRAINT "trip_shipments_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "transport"."delivery_trips"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "transport"."trip_stops" ADD CONSTRAINT "trip_stops_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "transport"."delivery_trips"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "transport"."route_plans" ADD CONSTRAINT "route_plans_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "transport"."delivery_trips"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "transport"."route_plans" ADD CONSTRAINT "route_plans_original_plan_id_fkey" FOREIGN KEY ("original_plan_id") REFERENCES "transport"."route_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "transport"."route_plan_stops" ADD CONSTRAINT "route_plan_stops_route_plan_id_fkey" FOREIGN KEY ("route_plan_id") REFERENCES "transport"."route_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "transport"."route_plan_stops" ADD CONSTRAINT "route_plan_stops_trip_stop_id_fkey" FOREIGN KEY ("trip_stop_id") REFERENCES "transport"."trip_stops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "transport"."delivery_attempts" ADD CONSTRAINT "delivery_attempts_trip_stop_id_fkey" FOREIGN KEY ("trip_stop_id") REFERENCES "transport"."trip_stops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "transport"."trip_dispatches" ADD CONSTRAINT "trip_dispatches_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "transport"."delivery_trips"("id") ON DELETE RESTRICT ON UPDATE CASCADE;