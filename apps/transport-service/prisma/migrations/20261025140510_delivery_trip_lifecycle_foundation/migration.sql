DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM transport.trip_dispatches
    WHERE status NOT IN ('COMPLETED', 'REJECTED')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Lifecycle migration blocked: drain or recover every pending/unknown TripDispatch before retrying';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM transport.delivery_trips t
    WHERE t.status = 'PLANNED'
      AND (
        t.dispatched_at IS NOT NULL
        OR t.actual_start_at IS NOT NULL
        OR t.dispatch_version <> 0
        OR EXISTS (
          SELECT 1
          FROM transport.trip_dispatches d
          WHERE d.tenant_id = t.tenant_id
            AND d.trip_id = t.id
        )
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Lifecycle migration blocked: PLANNED trips with dispatch evidence cannot be safely returned to DRAFT';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM transport.delivery_trips t
    WHERE t.status IN ('APPROVED', 'IN_PROGRESS')
      AND t.approved_route_plan_id IS NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Lifecycle migration blocked: APPROVED/IN_PROGRESS trip is missing its approved RoutePlan pointer';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM transport.delivery_trips t
    LEFT JOIN transport.route_plans rp
      ON rp.id = t.approved_route_plan_id
     AND rp.tenant_id = t.tenant_id
     AND rp.trip_id = t.id
    WHERE t.approved_route_plan_id IS NOT NULL
      AND (
        rp.id IS NULL
        OR rp.status <> 'APPROVED'
        OR rp.approved_by IS NULL
        OR rp.approved_at IS NULL
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Lifecycle migration blocked: approved RoutePlan pointer or its approval evidence is inconsistent';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM transport.route_plans
    WHERE status = 'APPROVED'
      AND (approved_by IS NULL OR approved_at IS NULL)
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Lifecycle migration blocked: approved RoutePlan is missing its real approver/time evidence';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM transport.route_plans
    WHERE status IN ('REJECTED', 'SUPERSEDED')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Lifecycle migration blocked: preserve REJECTED/SUPERSEDED RoutePlan decisions in the owning Audit service before removing status';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM transport.route_plans
    WHERE status = 'PROPOSED'
      AND (approved_by IS NOT NULL OR approved_at IS NOT NULL)
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Lifecycle migration blocked: PROPOSED RoutePlan has approval evidence inconsistent with its decision';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM transport.trip_stops s
    WHERE s.status = 'ARRIVED'
      AND (
        s.completed_at IS NOT NULL
        OR EXISTS (
          SELECT 1
          FROM transport.delivery_attempts a
          WHERE a.trip_stop_id = s.id
        )
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Lifecycle migration blocked: ARRIVED stop has terminal/attempt evidence and needs owner review';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM transport.delivery_attempts
    WHERE status NOT IN ('DELIVERED', 'FAILED')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Lifecycle migration blocked: non-terminal DeliveryAttempt records cannot be converted or discarded';
  END IF;

  IF EXISTS (
    SELECT tenant_id, vehicle_id
    FROM transport.delivery_trips
    WHERE status IN ('APPROVED', 'IN_PROGRESS')
      AND vehicle_id IS NOT NULL
    GROUP BY tenant_id, vehicle_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Lifecycle migration blocked: multiple active trips share a vehicle';
  END IF;

  IF EXISTS (
    SELECT tenant_id, driver_id
    FROM transport.delivery_trips
    WHERE status IN ('APPROVED', 'IN_PROGRESS')
      AND driver_id IS NOT NULL
    GROUP BY tenant_id, driver_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Lifecycle migration blocked: multiple active trips share a Driver';
  END IF;
END
$$;

DROP INDEX IF EXISTS transport.ix_trips_driver_active;
DROP INDEX IF EXISTS transport.ix_trips_vehicle_active;
CREATE UNIQUE INDEX ux_trips_driver_active
  ON transport.delivery_trips (tenant_id, driver_id)
  WHERE status IN ('APPROVED', 'IN_PROGRESS');
CREATE UNIQUE INDEX ux_trips_vehicle_active
  ON transport.delivery_trips (tenant_id, vehicle_id)
  WHERE status IN ('APPROVED', 'IN_PROGRESS');

UPDATE transport.delivery_trips
SET status = 'DRAFT',
    version = version + 1,
    updated_at = now()
WHERE status = 'PLANNED';

UPDATE transport.trip_stops
SET status = 'PENDING',
    version = version + 1,
    updated_at = now()
WHERE status = 'ARRIVED';

ALTER TABLE transport.delivery_trips
  DROP CONSTRAINT ck_delivery_trips_status;
ALTER TABLE transport.delivery_trips
  ADD CONSTRAINT ck_delivery_trips_status
  CHECK (status IN ('DRAFT', 'APPROVED', 'IN_PROGRESS', 'COMPLETED', 'CANCELED'));

ALTER TABLE transport.trip_stops
  DROP CONSTRAINT ck_trip_stops_status;
ALTER TABLE transport.trip_stops
  ADD CONSTRAINT ck_trip_stops_status
  CHECK (status IN ('PENDING', 'DELIVERED', 'FAILED'));

ALTER TABLE transport.delivery_attempts
  ADD CONSTRAINT ck_delivery_attempts_terminal_outcome
  CHECK (status IN ('DELIVERED', 'FAILED'));

DROP INDEX IF EXISTS transport.ux_route_plan_approved;
ALTER TABLE transport.route_plans
  DROP CONSTRAINT ck_route_plans_status;
ALTER TABLE transport.route_plans
  DROP COLUMN status;
