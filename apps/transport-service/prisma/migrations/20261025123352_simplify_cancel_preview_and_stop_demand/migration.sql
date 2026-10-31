/*
  Warnings:

  - You are about to drop the column `volume` on the `trip_stops` table. All the data in the column will be lost.
  - You are about to drop the column `weight` on the `trip_stops` table. All the data in the column will be lost.
  - You are about to drop the `trip_cancel_previews` table. If the table is not empty, all the data it contains will be lost.

*/
-- Backfill legacy stop-only demand into its matching membership before removing
-- the duplicate columns. Fail closed when a historical stop cannot be matched
-- to exactly one membership row or when non-zero values disagree.
DO $$
DECLARE
    stop_row RECORD;
    membership_row RECORD;
    candidate_count INTEGER;
BEGIN
    FOR stop_row IN
        SELECT id, tenant_id, trip_id, shipment_id, deleted_at, weight, volume
        FROM "trip_stops"
        WHERE weight IS NOT NULL OR volume IS NOT NULL
    LOOP
        IF stop_row.deleted_at IS NULL THEN
            SELECT count(*) INTO candidate_count
            FROM "trip_shipments"
            WHERE tenant_id = stop_row.tenant_id
              AND trip_id = stop_row.trip_id
              AND shipment_id = stop_row.shipment_id
              AND state IN ('ACTIVE', 'RELEASE_PENDING')
              AND removed_at IS NULL
              AND deleted_at IS NULL;

            IF candidate_count <> 1 THEN
                RAISE EXCEPTION
                    'Unsafe TripStop demand backfill for stop %, expected one active membership, found %',
                    stop_row.id, candidate_count;
            END IF;

            SELECT * INTO membership_row
            FROM "trip_shipments"
            WHERE tenant_id = stop_row.tenant_id
              AND trip_id = stop_row.trip_id
              AND shipment_id = stop_row.shipment_id
              AND state IN ('ACTIVE', 'RELEASE_PENDING')
              AND removed_at IS NULL
              AND deleted_at IS NULL
            ORDER BY assigned_at DESC, id DESC
            LIMIT 1;
        ELSE
            SELECT count(*) INTO candidate_count
            FROM "trip_shipments"
            WHERE tenant_id = stop_row.tenant_id
              AND trip_id = stop_row.trip_id
              AND shipment_id = stop_row.shipment_id
              AND assigned_at = (
                  SELECT max(assigned_at)
                  FROM "trip_shipments"
                  WHERE tenant_id = stop_row.tenant_id
                    AND trip_id = stop_row.trip_id
                    AND shipment_id = stop_row.shipment_id
                    AND assigned_at <= stop_row.deleted_at
              );

            IF candidate_count <> 1 THEN
                RAISE EXCEPTION
                    'Unsafe TripStop demand backfill for removed stop %, expected one historical membership, found %',
                    stop_row.id, candidate_count;
            END IF;

            SELECT * INTO membership_row
            FROM "trip_shipments"
            WHERE tenant_id = stop_row.tenant_id
              AND trip_id = stop_row.trip_id
              AND shipment_id = stop_row.shipment_id
              AND assigned_at = (
                  SELECT max(assigned_at)
                  FROM "trip_shipments"
                  WHERE tenant_id = stop_row.tenant_id
                    AND trip_id = stop_row.trip_id
                    AND shipment_id = stop_row.shipment_id
                    AND assigned_at <= stop_row.deleted_at
              )
            ORDER BY id DESC
            LIMIT 1;
        END IF;

        IF stop_row.weight IS NOT NULL
           AND membership_row.weight <> stop_row.weight
           AND membership_row.weight <> 0 THEN
            RAISE EXCEPTION
                'Unsafe TripStop weight backfill for stop %, membership %, values disagree',
                stop_row.id, membership_row.id;
        END IF;
        IF stop_row.volume IS NOT NULL
           AND membership_row.volume <> stop_row.volume
           AND membership_row.volume <> 0 THEN
            RAISE EXCEPTION
                'Unsafe TripStop volume backfill for stop %, membership %, values disagree',
                stop_row.id, membership_row.id;
        END IF;

        UPDATE "trip_shipments"
        SET weight = CASE
                WHEN stop_row.weight IS NOT NULL AND weight = 0 THEN stop_row.weight
                ELSE weight
            END,
            volume = CASE
                WHEN stop_row.volume IS NOT NULL AND volume = 0 THEN stop_row.volume
                ELSE volume
            END
        WHERE id = membership_row.id;
    END LOOP;
END $$;

-- Stop demand now derives from the matching TripShipment membership.
ALTER TABLE "trip_stops" DROP COLUMN "volume",
DROP COLUMN "weight";

-- DropTable
DROP TABLE "trip_cancel_previews";
