-- AlterTable
ALTER TABLE "transport"."route_plan_stops" ADD COLUMN     "leg_duration_seconds" INTEGER,
ALTER COLUMN "distance_from_previous" DROP NOT NULL,
ALTER COLUMN "cumulative_distance" DROP NOT NULL,
ALTER COLUMN "estimated_arrival_at" DROP NOT NULL;

-- AlterTable
ALTER TABLE "transport"."route_plans" ADD COLUMN     "approval_hash" VARCHAR(64),
ADD COLUMN     "approval_receipt" JSONB,
ADD COLUMN     "approval_request_id" UUID,
ADD COLUMN     "driver_snapshot" JSONB,
ADD COLUMN     "optimization_run_id" UUID,
ADD COLUMN     "optimizer_request" JSONB,
ADD COLUMN     "optimizer_response" JSONB,
ADD COLUMN     "request_actor_id" UUID,
ADD COLUMN     "request_hash" VARCHAR(64),
ADD COLUMN     "vehicle_snapshot" JSONB,
ALTER COLUMN "solver_name" DROP NOT NULL,
ALTER COLUMN "solver_version" DROP NOT NULL,
ALTER COLUMN "objective" DROP NOT NULL,
ALTER COLUMN "total_distance" DROP NOT NULL,
ALTER COLUMN "estimated_cost" DROP NOT NULL,
ALTER COLUMN "metrics" DROP NOT NULL;

-- The lifecycle foundation already owns the two partial resource unique indexes.
-- Their predicates intentionally include soft-deleted APPROVED/IN_PROGRESS rows.
ALTER TABLE "transport"."delivery_trips" ADD CONSTRAINT "ck_trip_active_resources"
CHECK ("status" NOT IN ('APPROVED', 'IN_PROGRESS') OR
  ("vehicle_id" IS NOT NULL AND "driver_id" IS NOT NULL));
CREATE UNIQUE INDEX "ux_route_approval_request" ON "transport"."route_plans" ("tenant_id", "approval_request_id")
WHERE "approval_request_id" IS NOT NULL;

ALTER TABLE "transport"."route_plans" DROP CONSTRAINT "ck_route_plans_source";
ALTER TABLE "transport"."route_plans" ADD CONSTRAINT "ck_route_plans_source"
CHECK ("source" IN ('MANUAL', 'OPTIMIZED', 'OVERRIDE', 'OPTIMIZER', 'MANUAL_OVERRIDE'));
ALTER TABLE "transport"."route_plans" ADD CONSTRAINT "ck_route_override_evidence"
CHECK ("source" <> 'OVERRIDE' OR ("override_reason" IS NOT NULL AND length(btrim("override_reason")) > 0 AND "original_plan_id" IS NOT NULL));
