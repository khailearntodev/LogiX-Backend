import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const service = fileURLToPath(new URL('..', import.meta.url));
const suffix = randomUUID().replaceAll('-', '');
const scratch = path.join(service, `.migration-upgrade-${suffix}`);
const source = path.join(service, 'prisma', 'migrations');
const copied = path.join(scratch, 'migrations');
const image = 'postgres:17-bookworm';
const database = `transport_upgrade_${suffix}`;
const env = {
  ...process.env,
  POSTGRES_PASSWORD: randomBytes(24).toString('hex'),
};
let container;
let client;
let unsafeClient;
let checks = 0;

function run(command, args, capture = false) {
  const result = spawnSync(command, args, {
    cwd: service,
    env,
    encoding: 'utf8',
    shell: command === 'pnpm' && process.platform === 'win32',
    stdio: capture ? 'pipe' : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} ${args[0]} failed (${result.status})`);
  return result.stdout?.trim();
}

function runExpectingFailure(command, args) {
  const result = spawnSync(command, args, {
    cwd: service,
    env,
    encoding: 'utf8',
    shell: command === 'pnpm' && process.platform === 'win32',
    stdio: 'pipe',
  });
  if (result.error) throw result.error;
  assert.notEqual(
    result.status,
    0,
    `${command} ${args[0]} unexpectedly succeeded`,
  );
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

async function rejectsConstraint(sql, values, constraint) {
  await assert.rejects(
    client.query(sql, values),
    (error) => error.code === (constraint.startsWith('ck_') ? '23514' : '23505') && error.constraint === constraint,
  );
  checks++;
}

try {
  run('docker', ['image', 'inspect', image], true);
  container = run(
    'docker',
    [
      'run',
      '--rm',
      '--pull=never',
      '-d',
      '--name',
      `transport-upgrade-${suffix}`,
      '-e',
      'POSTGRES_PASSWORD',
      '-e',
      `POSTGRES_DB=${database}`,
      '-p',
      '127.0.0.1::5432',
      image,
    ],
    true,
  );
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    const probe = spawnSync(
      'docker',
      ['exec', container, 'pg_isready', '-U', 'postgres', '-d', database],
      { stdio: 'ignore' },
    );
    if (probe.status === 0) {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!ready)
    throw new Error('Owned migration PostgreSQL did not become ready');
  const port = run('docker', ['port', container, '5432/tcp'], true)
    .split(':')
    .at(-1);
  assert.match(port, /^\d+$/);
  const connectionString = `postgresql://postgres:${env.POSTGRES_PASSWORD}@127.0.0.1:${port}/${database}`;
  env.DATABASE_URL = `${connectionString}?schema=transport`;
  for (let attempt = 0; attempt < 40; attempt++) {
    const candidate = new pg.Client({ connectionString });
    try {
      await candidate.connect();
      client = candidate;
      break;
    } catch {
      await candidate.end().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  if (!client)
    throw new Error('Owned PostgreSQL connection did not become ready');

  await mkdir(copied, { recursive: true });
  await cp(
    path.join(source, 'migration_lock.toml'),
    path.join(copied, 'migration_lock.toml'),
  );
  const migrations = (await readdir(source, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const firstPhase2 = migrations.indexOf(
    '20261025095046_phase2_trip_draft_membership_operations',
  );
  assert.equal(firstPhase2, 4, 'Expected four committed Phase 1 migrations');
  const simplificationMigration = migrations.find((name) =>
    name.includes('simplify_cancel_preview_and_stop_demand'),
  );
  assert.match(
    simplificationMigration,
    /simplify_cancel_preview_and_stop_demand/,
  );
  const lifecycleMigration = migrations.find((name) => name.includes('delivery_trip_lifecycle_foundation'));
  assert.match(lifecycleMigration, /delivery_trip_lifecycle_foundation/);
  const phase3Migration = migrations.find((name) => name.includes('phase3_routes_approval_resources'));
  assert.match(phase3Migration, /phase3_routes_approval_resources/);
  const phase3Index = migrations.indexOf(phase3Migration);
  const simplificationIndex = migrations.indexOf(simplificationMigration);
  for (const name of migrations.slice(0, firstPhase2)) {
    await cp(path.join(source, name), path.join(copied, name), {
      recursive: true,
    });
  }
  await writeFile(
    path.join(scratch, 'prisma.config.ts'),
    [
      "import { defineConfig } from 'prisma/config';",
      'export default defineConfig({',
      `schema: ${JSON.stringify(path.join(service, 'prisma', 'schema.prisma'))},`,
      `migrations: { path: ${JSON.stringify(copied)} },`,
      'datasource: { url: process.env.DATABASE_URL! },',
      '});',
    ].join('\n'),
  );
  const deploy = () =>
    run('pnpm', [
      'exec',
      'prisma',
      'migrate',
      'deploy',
      '--config',
      path.join(scratch, 'prisma.config.ts'),
    ]);
  deploy();

  const tenantId = randomUUID();
  const warehouseId = randomUUID();
  const legacyTrip = randomUUID();
  const legacyPlannedTripId = randomUUID();
  const shipmentId = randomUUID();
  const membershipId = randomUUID();
  const stopId = randomUUID();
  const legacyArrivedStopId = randomUUID();
  const approvedPlanId = randomUUID();
  const proposedPlanId = randomUUID();
  const legacyVehicleId = randomUUID();
  const legacyDriverId = randomUUID();
  const approvalActorId = randomUUID();
  const approvedAt = new Date('2026-10-20T10:00:00Z');
  const arrivedAt = new Date('2026-10-21T11:30:00Z');
  const address = {
    addressId: randomUUID(),
    latitude: '10.234567',
    longitude: '106.234567',
  };
  await client.query(
    `
    INSERT INTO transport.delivery_trips
    (id,tenant_id,trip_number,warehouse_id,vehicle_id,driver_id,status,planned_start_at,
     total_weight,total_volume,dispatch_version,depot_snapshot,version)
    VALUES ($1,$2,'LEGACY',$3,$4,$5,'DRAFT','2026-10-01T10:00:00Z',1.125,0.011250,0,$6,7)`,
    [
      legacyTrip,
      tenantId,
      warehouseId,
      randomUUID(),
      randomUUID(),
      { warehouseId },
    ],
  );
  await client.query(
    `
    INSERT INTO transport.delivery_trips
    (id,tenant_id,trip_number,warehouse_id,vehicle_id,driver_id,status,planned_start_at,
     total_weight,total_volume,dispatch_version,depot_snapshot)
    VALUES ($1,$2,'LEGACY-PLANNED',$3,$4,$5,'PLANNED',now(),1,0.01,0,$6)`,
    [
      legacyPlannedTripId,
      tenantId,
      warehouseId,
      legacyVehicleId,
      legacyDriverId,
      { warehouseId },
    ],
  );
  await client.query(
    `
    INSERT INTO transport.route_plans
    (id,tenant_id,trip_id,plan_version,route_request_id,status,source,input_hash,
     input_snapshot,solver_name,solver_version,objective,total_distance,estimated_cost,
     metrics,approved_by,approved_at)
    VALUES ($1,$2,$3,1,$4,'APPROVED','OPTIMIZER',$5,$6,'legacy-solver','1','distance',
     10,1,$7,$8,$9)`,
    [
      approvedPlanId,
      tenantId,
      legacyPlannedTripId,
      randomUUID(),
      'a'.repeat(64),
      {},
      {},
      approvalActorId,
      approvedAt,
    ],
  );
  await client.query(
    `
    INSERT INTO transport.route_plans
    (id,tenant_id,trip_id,plan_version,route_request_id,status,source,input_hash,
     input_snapshot,solver_name,solver_version,objective,total_distance,estimated_cost,
     metrics)
    VALUES ($1,$2,$3,2,$4,'PROPOSED','OPTIMIZER',$5,$6,'legacy-solver','1','distance',
     12,1,$7)`,
    [
      proposedPlanId,
      tenantId,
      legacyPlannedTripId,
      randomUUID(),
      'b'.repeat(64),
      {},
      {},
    ],
  );
  await client.query(
    'UPDATE transport.delivery_trips SET approved_route_plan_id=$1 WHERE id=$2',
    [approvedPlanId, legacyPlannedTripId],
  );
  await client.query(
    `
    INSERT INTO transport.trip_stops
    (id,tenant_id,trip_id,shipment_id,delivery_address_id,address_snapshot,
     planned_sequence,status,current_attempt,arrived_at)
    VALUES ($1,$2,$3,$4,$5,$6,1,'ARRIVED',2,$7)`,
    [
      legacyArrivedStopId,
      tenantId,
      legacyPlannedTripId,
      randomUUID(),
      randomUUID(),
      { addressId: randomUUID() },
      arrivedAt,
    ],
  );
  await client.query(
    `
    INSERT INTO transport.trip_shipments
    (id,tenant_id,trip_id,shipment_id,warehouse_id,weight,volume,version)
    VALUES ($1,$2,$3,$4,$5,1.125,0.011250,4)`,
    [membershipId, tenantId, legacyTrip, shipmentId, warehouseId],
  );
  await client.query(
    `
    INSERT INTO transport.trip_stops
    (id,tenant_id,trip_id,shipment_id,delivery_address_id,address_snapshot,
     latitude,longitude,planned_sequence,status,version)
    VALUES ($1,$2,$3,$4,$5,$6,10.234567,106.234567,1,'PENDING',3)`,
    [stopId, tenantId, legacyTrip, shipmentId, address.addressId, address],
  );
  const rows = async () => {
    const result = {};
    for (const table of ['delivery_trips', 'trip_shipments', 'trip_stops']) {
      result[table] = (
        await client.query(`SELECT * FROM transport.${table} ORDER BY id`)
      ).rows;
    }
    return result;
  };
  const before = await rows();
  for (const name of migrations.slice(firstPhase2, simplificationIndex)) {
    await cp(path.join(source, name), path.join(copied, name), {
      recursive: true,
    });
  }
  deploy();
  const afterPhase2 = await rows();
  for (const table of Object.keys(before)) {
    assert.equal(afterPhase2[table].length, before[table].length);
    for (const [index, old] of before[table].entries()) {
      for (const key of Object.keys(old)) {
        assert.deepEqual(
          afterPhase2[table][index][key],
          old[key],
          `${table}.${key} changed`,
        );
      }
    }
    checks++;
  }
  const membership = afterPhase2.trip_shipments[0];
  assert.equal(membership.state, 'ACTIVE');
  for (const key of [
    'operation_id',
    'order_id',
    'order_version',
    'expected_shipment_version',
    'shipment_version',
    'claim_request',
    'claim_receipt',
    'release_request',
    'release_receipt',
    'shipment_snapshot',
  ])
    assert.equal(membership[key], null, key);
  assert.equal(afterPhase2.trip_stops[0].weight, null);
  assert.equal(afterPhase2.trip_stops[0].volume, null);
  assert.equal(afterPhase2.delivery_trips[0].driver_user_id, null);
  assert.equal(afterPhase2.delivery_trips[0].driver_version, null);
  checks++;

  const readdedMembershipId = randomUUID();
  const readdedAt = new Date('2026-10-22T10:00:00Z');
  const legacyStopWeight = '2.750';
  const legacyStopVolume = '0.031250';
  await client.query(
    `UPDATE transport.trip_shipments
     SET state='RELEASED', removed_at='2026-10-21T10:00:00Z'
     WHERE id=$1`,
    [membershipId],
  );
  await client.query(
    `UPDATE transport.trip_stops
     SET weight=$2, volume=$3
     WHERE id=$1`,
    [stopId, legacyStopWeight, legacyStopVolume],
  );
  await client.query(
    `
    INSERT INTO transport.trip_shipments
    (id,tenant_id,trip_id,shipment_id,warehouse_id,weight,volume,state,assigned_at)
    VALUES ($1,$2,$3,$4,$5,0,0,'ACTIVE',$6)`,
    [
      readdedMembershipId,
      tenantId,
      legacyTrip,
      shipmentId,
      warehouseId,
      readdedAt,
    ],
  );

  const historicalShipmentId = randomUUID();
  const historicalMembershipId = randomUUID();
  const historicalReaddedMembershipId = randomUUID();
  const historicalStopId = randomUUID();
  await client.query(
    `
    INSERT INTO transport.trip_shipments
    (id,tenant_id,trip_id,shipment_id,warehouse_id,weight,volume,state,assigned_at,removed_at)
    VALUES ($1,$2,$3,$4,$5,0,0,'RELEASED','2026-10-01T10:00:00Z','2026-10-10T10:00:00Z')`,
    [
      historicalMembershipId,
      tenantId,
      legacyTrip,
      historicalShipmentId,
      warehouseId,
    ],
  );
  await client.query(
    `
    INSERT INTO transport.trip_shipments
    (id,tenant_id,trip_id,shipment_id,warehouse_id,weight,volume,state,assigned_at)
    VALUES ($1,$2,$3,$4,$5,9,0.9,'ACTIVE','2026-10-15T10:00:00Z')`,
    [
      historicalReaddedMembershipId,
      tenantId,
      legacyTrip,
      historicalShipmentId,
      warehouseId,
    ],
  );
  await client.query(
    `
    INSERT INTO transport.trip_stops
    (id,tenant_id,trip_id,shipment_id,delivery_address_id,address_snapshot,
     latitude,longitude,weight,volume,planned_sequence,status,deleted_at)
    VALUES ($1,$2,$3,$4,$5,$6,10.234567,106.234567,3.5,0.35,2,'PENDING',
     '2026-10-12T10:00:00Z')`,
    [
      historicalStopId,
      tenantId,
      legacyTrip,
      historicalShipmentId,
      randomUUID(),
      address,
    ],
  );

  const draftId = randomUUID();
  await client.query(
    `
    INSERT INTO transport.delivery_trips
    (id,tenant_id,trip_number,warehouse_id,vehicle_id,driver_id,status,planned_start_at,
     total_weight,total_volume,dispatch_version,depot_snapshot)
    VALUES ($1,$2,'NULL-REFS',$3,NULL,NULL,'DRAFT',now(),0,0,0,$4)`,
    [draftId, tenantId, warehouseId, { warehouseId }],
  );
  checks++;
  const pendingOperationId = randomUUID();
  const pendingRequestId = randomUUID();
  const pendingActorId = randomUUID();
  const pendingLock = `${tenantId}:${draftId}`;
  await client.query(
    `
      INSERT INTO transport.trip_operations
      (id,tenant_id,trip_id,request_id,actor_id,kind,status,payload_hash,payload,active_lock)
      VALUES ($1,$2,$3,$4,$5,'ADD','PENDING',$6,$7,$8)`,
    [
      pendingOperationId,
      tenantId,
      draftId,
      pendingRequestId,
      pendingActorId,
      'c'.repeat(64),
      {},
      pendingLock,
    ],
  );
  const oldPreviewId = randomUUID();
  await client.query(
    `
      INSERT INTO transport.trip_cancel_previews
      (id,tenant_id,trip_id,actor_id,version,payload_hash,expires_at)
      VALUES ($1,$2,$3,$4,1,$5,now()+interval '5 minutes')`,
    [oldPreviewId, tenantId, legacyTrip, randomUUID(), 'd'.repeat(64)],
  );

  for (const name of migrations.slice(simplificationIndex, phase3Index)) {
    await cp(path.join(source, name), path.join(copied, name), {
      recursive: true,
    });
  }
  deploy();
  const migrated = await rows();
  assert.equal(
    (
      await client.query(`
      SELECT count(*)::int AS count
      FROM information_schema.columns
      WHERE table_schema='transport' AND table_name='trip_stops'
        AND column_name IN ('weight','volume')`)
    ).rows[0].count,
    0,
  );
  assert.equal(
    (
      await client.query(
        "SELECT to_regclass('transport.trip_cancel_previews') IS NULL AS dropped",
      )
    ).rows[0].dropped,
    true,
  );
  assert.equal(
    (
      await client.query(
        'SELECT status,active_lock FROM transport.trip_operations WHERE id=$1',
        [pendingOperationId],
      )
    ).rows[0].status,
    'PENDING',
  );
  assert.equal(
    (
      await client.query(
        'SELECT active_lock FROM transport.trip_operations WHERE id=$1',
        [pendingOperationId],
      )
    ).rows[0].active_lock,
    pendingLock,
  );
  await client.query(
    `UPDATE transport.trip_operations
       SET status='COMPLETED', active_lock=NULL WHERE id=$1`,
    [pendingOperationId],
  );
  const backfilledActive = await client.query(
    'SELECT weight::text,volume::text FROM transport.trip_shipments WHERE id=$1',
    [readdedMembershipId],
  );
  assert.equal(backfilledActive.rows[0].weight, legacyStopWeight);
  assert.equal(backfilledActive.rows[0].volume, legacyStopVolume);
  const untouchedHistory = await client.query(
    'SELECT weight::text,volume::text FROM transport.trip_shipments WHERE id=$1',
    [membershipId],
  );
  assert.equal(untouchedHistory.rows[0].weight, '1.125');
  assert.equal(untouchedHistory.rows[0].volume, '0.011250');
  const backfilledRemovedHistory = await client.query(
    'SELECT weight::text,volume::text FROM transport.trip_shipments WHERE id=$1',
    [historicalMembershipId],
  );
  assert.equal(backfilledRemovedHistory.rows[0].weight, '3.500');
  assert.equal(backfilledRemovedHistory.rows[0].volume, '0.350000');
  const untouchedReaddedHistory = await client.query(
    'SELECT weight::text,volume::text FROM transport.trip_shipments WHERE id=$1',
    [historicalReaddedMembershipId],
  );
  assert.equal(untouchedReaddedHistory.rows[0].weight, '9.000');
  assert.equal(untouchedReaddedHistory.rows[0].volume, '0.900000');
  assert.equal(migrated.trip_stops.length, 3);
  assert.equal(migrated.trip_shipments.length, 4);
  assert.equal(migrated.delivery_trips.length, 3);
  const migratedPlannedTrip = await client.query(
    `SELECT status,version,approved_route_plan_id
       FROM transport.delivery_trips WHERE id=$1`,
    [legacyPlannedTripId],
  );
  assert.deepEqual(migratedPlannedTrip.rows[0], {
    status: 'DRAFT',
    version: '2',
    approved_route_plan_id: approvedPlanId,
  });
  const migratedArrivedStop = await client.query(
    `SELECT status,current_attempt,arrived_at,version
       FROM transport.trip_stops WHERE id=$1`,
    [legacyArrivedStopId],
  );
  assert.equal(migratedArrivedStop.rows[0].status, 'PENDING');
  assert.equal(migratedArrivedStop.rows[0].current_attempt, 2);
  assert.equal(migratedArrivedStop.rows[0].arrived_at.toISOString(), arrivedAt.toISOString());
  assert.equal(migratedArrivedStop.rows[0].version, '2');
  const routePlanEvidence = await client.query(
    `SELECT id,approved_by,approved_at
       FROM transport.route_plans WHERE id=$1`,
    [approvedPlanId],
  );
  assert.deepEqual(routePlanEvidence.rows[0], {
    id: approvedPlanId,
    approved_by: approvalActorId,
    approved_at: approvedAt,
  });
  assert.equal(
    (
      await client.query(`
        SELECT count(*)::int AS count
        FROM information_schema.columns
        WHERE table_schema='transport' AND table_name='route_plans'
          AND column_name='status'`)
    ).rows[0].count,
    0,
  );
  assert.equal(
    (
      await client.query(
        `SELECT count(*)::int AS count FROM transport.route_plans
          WHERE id IN ($1,$2)`,
        [approvedPlanId, proposedPlanId],
      )
    ).rows[0].count,
    2,
  );
  await assert.rejects(
    client.query(
      `UPDATE transport.delivery_trips SET status='PLANNED' WHERE id=$1`,
      [legacyPlannedTripId],
    ),
    (error) =>
      error.code === '23514' &&
      error.constraint === 'ck_delivery_trips_status',
  );
  await assert.rejects(
    client.query(
      `UPDATE transport.trip_stops SET status='ARRIVED' WHERE id=$1`,
      [legacyArrivedStopId],
    ),
    (error) =>
      error.code === '23514' && error.constraint === 'ck_trip_stops_status',
  );
  await assert.rejects(
    client.query(
      `INSERT INTO transport.delivery_attempts
       (id,tenant_id,trip_stop_id,shipment_id,attempt_number,status,actor_driver_id,
        occurred_at,correlation_id)
       VALUES ($1,$2,$3,$4,1,'PENDING',$5,now(),$6)`,
      [
        randomUUID(),
        tenantId,
        legacyArrivedStopId,
        randomUUID(),
        randomUUID(),
        randomUUID(),
      ],
    ),
    (error) =>
      error.code === '23514' &&
      error.constraint === 'ck_delivery_attempts_terminal_outcome',
  );
  await client.query(
    `UPDATE transport.delivery_trips SET status='APPROVED' WHERE id=$1`,
    [legacyPlannedTripId],
  );
  const vehicleConflictTripId = randomUUID();
  await client.query(
    `INSERT INTO transport.delivery_trips
     (id,tenant_id,trip_number,warehouse_id,vehicle_id,driver_id,status,planned_start_at,
      total_weight,total_volume,dispatch_version,depot_snapshot)
     VALUES ($1,$2,'VEHICLE-DRAFT',$3,$4,$5,'DRAFT',now(),0,0,0,$6)`,
    [
      vehicleConflictTripId,
      tenantId,
      warehouseId,
      legacyVehicleId,
      randomUUID(),
      { warehouseId },
    ],
  );
  await rejectsConstraint(
    `UPDATE transport.delivery_trips SET status='APPROVED' WHERE id=$1`,
    [vehicleConflictTripId],
    'ux_trips_vehicle_active',
  );
  const driverConflictTripId = randomUUID();
  await client.query(
    `INSERT INTO transport.delivery_trips
     (id,tenant_id,trip_number,warehouse_id,vehicle_id,driver_id,status,planned_start_at,
      total_weight,total_volume,dispatch_version,depot_snapshot)
     VALUES ($1,$2,'DRIVER-DRAFT',$3,$4,$5,'DRAFT',now(),0,0,0,$6)`,
    [
      driverConflictTripId,
      tenantId,
      warehouseId,
      randomUUID(),
      legacyDriverId,
      { warehouseId },
    ],
  );
  await rejectsConstraint(
    `UPDATE transport.delivery_trips SET status='IN_PROGRESS' WHERE id=$1`,
    [driverConflictTripId],
    'ux_trips_driver_active',
  );
  checks += 14;
  checks += 8;

  const beforePhase3 = (await client.query(
    'SELECT id,approved_by,approved_at,input_hash,input_snapshot FROM transport.route_plans ORDER BY id',
  )).rows;
  await cp(path.join(source, phase3Migration), path.join(copied, phase3Migration), { recursive: true });
  deploy();
  assert.deepEqual((await client.query(
    'SELECT id,approved_by,approved_at,input_hash,input_snapshot FROM transport.route_plans ORDER BY id',
  )).rows, beforePhase3);
  const indexes = (await client.query(`
    SELECT indexname,indexdef FROM pg_indexes
    WHERE schemaname='transport' AND tablename='delivery_trips'
      AND indexdef LIKE 'CREATE UNIQUE INDEX%' AND indexdef LIKE '%IN_PROGRESS%'
    ORDER BY indexname`)).rows;
  assert.deepEqual(indexes.map((row) => row.indexname), ['ux_trips_driver_active', 'ux_trips_vehicle_active']);
  for (const row of indexes) {
    assert.match(row.indexdef, /APPROVED/);
    assert.doesNotMatch(row.indexdef, /deleted_at/);
  }
  assert.equal((await client.query(`
    SELECT count(*)::int AS count FROM information_schema.tables
    WHERE table_schema='transport' AND table_name LIKE '%lease%'`)).rows[0].count, 0);
  const manualId = randomUUID();
  await client.query(`
    INSERT INTO transport.route_plans
    (id,tenant_id,trip_id,plan_version,route_request_id,source,input_hash,input_snapshot)
    VALUES ($1,$2,$3,90,$4,'MANUAL',$5,$6)`,
    [manualId, tenantId, legacyTrip, randomUUID(), 'e'.repeat(64), { contractVersion: 1 }]);
  const unknownMetrics = (await client.query(`
    SELECT solver_name,solver_version,objective,total_distance,estimated_cost,metrics
    FROM transport.route_plans WHERE id=$1`, [manualId])).rows[0];
  assert(Object.values(unknownMetrics).every((value) => value === null));
  await client.query(`
    INSERT INTO transport.route_plan_stops
    (id,tenant_id,route_plan_id,trip_stop_id,sequence)
    VALUES ($1,$2,$3,$4,1)`, [randomUUID(), tenantId, manualId, stopId]);
  assert.equal((await client.query(`
    SELECT estimated_arrival_at,distance_from_previous,leg_duration_seconds
    FROM transport.route_plan_stops WHERE route_plan_id=$1`, [manualId])).rows[0].estimated_arrival_at, null);
  await rejectsConstraint(`UPDATE transport.delivery_trips SET status='APPROVED',vehicle_id=NULL WHERE id=$1`,
    [vehicleConflictTripId], 'ck_trip_active_resources');
  await rejectsConstraint(`UPDATE transport.delivery_trips SET status='IN_PROGRESS',driver_id=NULL WHERE id=$1`,
    [driverConflictTripId], 'ck_trip_active_resources');
  await rejectsConstraint(`UPDATE transport.route_plans SET source='OVERRIDE' WHERE id=$1`,
    [manualId], 'ck_route_override_evidence');
  await client.query(`UPDATE transport.delivery_trips SET deleted_at=now() WHERE id=$1`, [legacyPlannedTripId]);
  await rejectsConstraint(`UPDATE transport.delivery_trips SET status='APPROVED' WHERE id=$1`,
    [vehicleConflictTripId], 'ux_trips_vehicle_active');
  await client.query(`UPDATE transport.delivery_trips SET status='DRAFT' WHERE id=$1`, [legacyPlannedTripId]);
  await client.query(`UPDATE transport.delivery_trips SET status='APPROVED' WHERE id=$1`, [vehicleConflictTripId]);
  await client.query(`UPDATE transport.delivery_trips SET status='DRAFT' WHERE id=$1`, [vehicleConflictTripId]);
  checks += 13;

  const unsafeDatabase = `transport_unsafe_${suffix}`;
  await client.query(`CREATE DATABASE "${unsafeDatabase}"`);
  const unsafeMigrations = path.join(scratch, 'unsafe-migrations');
  await mkdir(unsafeMigrations, { recursive: true });
  await cp(
    path.join(source, 'migration_lock.toml'),
    path.join(unsafeMigrations, 'migration_lock.toml'),
  );
  for (const name of migrations.slice(0, simplificationIndex)) {
    await cp(path.join(source, name), path.join(unsafeMigrations, name), {
      recursive: true,
    });
  }
  const unsafeConfig = path.join(scratch, 'unsafe-prisma.config.ts');
  await writeFile(
    unsafeConfig,
    [
      "import { defineConfig } from 'prisma/config';",
      'export default defineConfig({',
      `schema: ${JSON.stringify(path.join(service, 'prisma', 'schema.prisma'))},`,
      `migrations: { path: ${JSON.stringify(unsafeMigrations)} },`,
      'datasource: { url: process.env.DATABASE_URL! },',
      '});',
    ].join('\n'),
  );
  const baseConnection = connectionString;
  env.DATABASE_URL = `${baseConnection.slice(0, baseConnection.lastIndexOf('/') + 1)}${unsafeDatabase}?schema=transport`;
  run('pnpm', [
    'exec',
    'prisma',
    'migrate',
    'deploy',
    '--config',
    unsafeConfig,
  ]);
  unsafeClient = new pg.Client({
    connectionString: `${baseConnection.slice(0, baseConnection.lastIndexOf('/') + 1)}${unsafeDatabase}`,
  });
  await unsafeClient.connect();
  const unsafeTripId = randomUUID();
  await unsafeClient.query(
    `
      INSERT INTO transport.delivery_trips
      (id,tenant_id,trip_number,warehouse_id,vehicle_id,driver_id,status,planned_start_at,
       total_weight,total_volume,dispatch_version,depot_snapshot)
      VALUES ($1,$2,'UNSAFE-BACKFILL',$3,$4,$5,'DRAFT',now(),0,0,0,$6)`,
    [
      unsafeTripId,
      tenantId,
      warehouseId,
      randomUUID(),
      randomUUID(),
      { warehouseId },
    ],
  );
  await unsafeClient.query(
    `
      INSERT INTO transport.trip_stops
      (id,tenant_id,trip_id,shipment_id,delivery_address_id,address_snapshot,
       weight,volume,planned_sequence,status)
      VALUES ($1,$2,$3,$4,$5,$6,4.25,0.42,1,'PENDING')`,
    [randomUUID(), tenantId, unsafeTripId, randomUUID(), randomUUID(), address],
  );
  await cp(
    path.join(source, simplificationMigration),
    path.join(unsafeMigrations, simplificationMigration),
    {
      recursive: true,
    },
  );
  env.DATABASE_URL = `${baseConnection.slice(0, baseConnection.lastIndexOf('/') + 1)}${unsafeDatabase}?schema=transport`;
  const unsafeOutput = runExpectingFailure('pnpm', [
    'exec',
    'prisma',
    'migrate',
    'deploy',
    '--config',
    unsafeConfig,
  ]);
  assert.match(unsafeOutput, /Unsafe TripStop demand backfill/);
  assert.equal(
    (
      await unsafeClient.query(`
      SELECT count(*)::int AS count FROM information_schema.columns
      WHERE table_schema='transport' AND table_name='trip_stops' AND column_name='weight'`)
    ).rows[0].count,
    1,
  );
  assert.equal(
    (
      await unsafeClient.query(
        "SELECT to_regclass('transport.trip_cancel_previews') IS NOT NULL AS table_exists",
      )
    ).rows[0].table_exists,
    true,
  );
  const unsafeStop = await unsafeClient.query(
    'SELECT id FROM transport.trip_stops WHERE trip_id=$1',
    [unsafeTripId],
  );
  await unsafeClient.query(
    'DELETE FROM transport.trip_stops WHERE id=$1',
    [unsafeStop.rows[0].id],
  );
  run('pnpm', [
    'exec',
    'prisma',
    'migrate',
    'resolve',
    '--rolled-back',
    simplificationMigration,
    '--config',
    unsafeConfig,
  ]);
  run('pnpm', [
    'exec',
    'prisma',
    'migrate',
    'deploy',
    '--config',
    unsafeConfig,
  ]);
  await unsafeClient.query(
    `
    INSERT INTO transport.trip_dispatches
    (id,tenant_id,trip_id,dispatch_version,idempotency_key,status,requested_by,
     requested_at,correlation_id)
    VALUES ($1,$2,$3,1,$4,'PENDING',$5,now(),$6)`,
    [randomUUID(), tenantId, unsafeTripId, randomUUID(), randomUUID(), randomUUID()],
  );
  await cp(
    path.join(source, lifecycleMigration),
    path.join(unsafeMigrations, lifecycleMigration),
    { recursive: true },
  );
  const pendingDispatchOutput = runExpectingFailure('pnpm', [
    'exec',
    'prisma',
    'migrate',
    'deploy',
    '--config',
    unsafeConfig,
  ]);
  assert.match(
    pendingDispatchOutput,
    /drain or recover every pending\/unknown TripDispatch/,
  );
  assert.equal(
    (
      await unsafeClient.query(
        'SELECT status FROM transport.trip_dispatches LIMIT 1',
      )
    ).rows[0].status,
    'PENDING',
  );
  run('pnpm', [
    'exec',
    'prisma',
    'migrate',
    'resolve',
    '--rolled-back',
    lifecycleMigration,
    '--config',
    unsafeConfig,
  ]);
  await unsafeClient.query(
    `UPDATE transport.trip_dispatches SET status='REJECTED'`,
  );
  await unsafeClient.query(
    `UPDATE transport.delivery_trips
       SET status='PLANNED',dispatch_version=1,dispatched_at=now()
       WHERE id=$1`,
    [unsafeTripId],
  );
  const plannedDispatchOutput = runExpectingFailure('pnpm', [
    'exec',
    'prisma',
    'migrate',
    'deploy',
    '--config',
    unsafeConfig,
  ]);
  assert.match(
    plannedDispatchOutput,
    /PLANNED trips with dispatch evidence cannot be safely returned to DRAFT/,
  );
  run('pnpm', [
    'exec',
    'prisma',
    'migrate',
    'resolve',
    '--rolled-back',
    lifecycleMigration,
    '--config',
    unsafeConfig,
  ]);
  await unsafeClient.query(
    `UPDATE transport.delivery_trips
       SET status='DRAFT',dispatch_version=0,dispatched_at=NULL
       WHERE id=$1`,
    [unsafeTripId],
  );
  await unsafeClient.query(
    `
    INSERT INTO transport.route_plans
    (id,tenant_id,trip_id,plan_version,route_request_id,status,source,input_hash,
     input_snapshot,solver_name,solver_version,objective,total_distance,estimated_cost,
     metrics)
    VALUES ($1,$2,$3,1,$4,'REJECTED','OPTIMIZER',$5,$6,'legacy-solver','1','distance',
     1,1,$7)`,
    [
      randomUUID(),
      tenantId,
      unsafeTripId,
      randomUUID(),
      'c'.repeat(64),
      {},
      {},
    ],
  );
  const rejectedRouteOutput = runExpectingFailure('pnpm', [
    'exec',
    'prisma',
    'migrate',
    'deploy',
    '--config',
    unsafeConfig,
  ]);
  assert.match(
    rejectedRouteOutput,
    /preserve REJECTED\/SUPERSEDED RoutePlan decisions in the owning Audit service/,
  );
  assert.equal(
    (
      await unsafeClient.query(
        `SELECT status FROM transport.route_plans WHERE trip_id=$1`,
        [unsafeTripId],
      )
    ).rows[0].status,
    'REJECTED',
  );
  assert.equal(
    (
      await unsafeClient.query(`
        SELECT count(*)::int AS count FROM information_schema.columns
        WHERE table_schema='transport' AND table_name='route_plans'
          AND column_name='status'`)
    ).rows[0].count,
    1,
  );
  await unsafeClient.end();
  unsafeClient = undefined;
  checks += 10;
  env.DATABASE_URL = `${connectionString}?schema=transport`;

  const insertMembership = `
    INSERT INTO transport.trip_shipments
    (id,tenant_id,trip_id,shipment_id,warehouse_id,weight,volume,state)
    VALUES ($1,$2,$3,$4,$5,0,0,'CLAIM_PENDING')`;
  await rejectsConstraint(
    insertMembership,
    [randomUUID(), tenantId, draftId, shipmentId, warehouseId],
    'ux_trip_active_shipment',
  );
  await client.query(
    'UPDATE transport.trip_shipments SET removed_at=now(),state=$2 WHERE id=$1',
    [readdedMembershipId, 'RELEASED'],
  );
  await client.query(insertMembership, [
    randomUUID(),
    tenantId,
    draftId,
    shipmentId,
    warehouseId,
  ]);
  assert.equal(
    (
      await client.query(
        'SELECT count(*)::int AS count FROM transport.trip_shipments WHERE shipment_id=$1',
        [shipmentId],
      )
    ).rows[0].count,
    3,
  );
  checks++;
  await rejectsConstraint(
    `
    INSERT INTO transport.trip_stops
    (id,tenant_id,trip_id,shipment_id,delivery_address_id,address_snapshot,
     planned_sequence,status) VALUES ($1,$2,$3,$4,$5,$6,2,'PENDING')`,
    [
      randomUUID(),
      tenantId,
      legacyTrip,
      shipmentId,
      address.addressId,
      address,
    ],
    'ux_trip_stop_shipment',
  );
  assert.equal(
    (
      await client.query(
        'SELECT count(*)::int AS count FROM transport.trip_operations',
      )
    ).rows[0].count,
    1,
  );
  checks++;
  const operationId = randomUUID();
  const insertOperation = `
    INSERT INTO transport.trip_operations
    (id,tenant_id,trip_id,request_id,actor_id,kind,status,payload_hash,payload,active_lock)
    VALUES ($1,$2,$3,$4,$5,'ADD','PENDING',$6,$7,$8)`;
  const requestId = randomUUID();
  const actorId = randomUUID();
  const lock = `${tenantId}:${draftId}`;
  await client.query(insertOperation, [
    operationId,
    tenantId,
    draftId,
    requestId,
    actorId,
    'a'.repeat(64),
    {},
    lock,
  ]);
  await rejectsConstraint(
    insertOperation,
    [
      randomUUID(),
      tenantId,
      draftId,
      randomUUID(),
      actorId,
      'b'.repeat(64),
      {},
      lock,
    ],
    'ux_trip_operation_active_lock',
  );
  await rejectsConstraint(
    insertOperation,
    [
      randomUUID(),
      tenantId,
      draftId,
      requestId,
      actorId,
      'b'.repeat(64),
      {},
      null,
    ],
    'ux_trip_operation_request',
  );
  await client.query(
    'UPDATE transport.trip_shipments SET operation_id=$1 WHERE trip_id=$2',
    [operationId, draftId],
  );
  await client.query('DELETE FROM transport.trip_operations WHERE id=$1', [
    operationId,
  ]);
  assert.equal(
    (
      await client.query(
        'SELECT operation_id FROM transport.trip_shipments WHERE trip_id=$1',
        [draftId],
      )
    ).rows[0].operation_id,
    null,
  );
  checks++;
  run('pnpm', [
    'exec',
    'prisma',
    'migrate',
    'status',
    '--config',
    path.join(scratch, 'prisma.config.ts'),
  ]);
  console.info(
    `Transport Phase 1/2 -> lifecycle -> Phase 3 migration upgrade PASS (${checks} checks)`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  if (unsafeClient) await unsafeClient.end().catch(() => {});
  if (client) await client.end();
  await rm(scratch, { recursive: true, force: true });
  if (container) {
    try {
      run('docker', ['rm', '-f', container], true);
      console.info(
        'Owned migration PostgreSQL and project-local scratch removed',
      );
    } catch {
      console.error('Owned migration PostgreSQL cleanup failed');
      process.exitCode = 1;
    }
  }
}
