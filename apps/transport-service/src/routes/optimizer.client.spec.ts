import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { OptimizerClient, optimizerResponseSchema } from './optimizer.client.js';

describe('Optimizer production protocol adapter (contract tier)', () => {
  const valid = {
    contract_version: 1, tenant_id: randomUUID(), trip_id: randomUUID(), route_request_id: randomUUID(),
    trip_version: 1, input_hash: 'a'.repeat(64), route_plan_id: randomUUID(), persisted: true,
    completed_at: '2026-10-25T12:00:00.000Z', solver_method: 'Google OR-Tools CVRP', solver_version: '9.15',
    config_version: 'route-v1;solver-limit=5s', objective: 'MINIMIZE_ROAD_DISTANCE', distance_provider: 'Haversine fallback',
    provider_version: null, feasibility_status: 'FEASIBLE', total_distance_km: 1.2, total_duration_minutes: 3,
    vehicle_capacity_weight_kg: 1, vehicle_capacity_volume_m3: 1, total_demand_weight_kg: 1, total_demand_volume_m3: 1,
    baseline_input_order_km: 1.2, baseline_nearest_neighbor_km: 1.2, polyline: [[106, 10]], legs: [],
    stops: [{ trip_stop_id: randomUUID(), sequence: 1, distance_from_prev_km: 1.2,
      estimated_duration_minutes: 3, lat: 10, lng: 106, demand_weight_kg: 1, demand_volume_m3: 1 }],
  };
  const client = new OptimizerClient(new ConfigService({
    INTERNAL_SERVICE_JWT_SECRET: 'owned-optimizer-protocol-test-key'.repeat(2),
    ROUTE_OPTIMIZER_SERVICE_URL: 'http://127.0.0.1:12345', ROUTE_OPTIMIZER_TIMEOUT_MS: 5000,
  }));
  afterEach(() => vi.unstubAllGlobals());
  it.each([
    { persisted: false }, { feasibility_status: 'INFEASIBLE' }, { stops: [] }, { solver_version: '' },
    { total_distance_km: -1 }, { total_demand_volume_m3: Number.NaN }, { input_hash: 'sample' },
  ])('rejects unpersisted/infeasible/malformed production evidence %j', (mutation) => {
    expect(optimizerResponseSchema.safeParse({ ...valid, ...mutation }).success).toBe(false);
  });
  it('maps invalid JSON to a definite protocol error instead of a valid proposal', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not-json', { status: 200 })));
    await expect(client.compute(valid.tenant_id, {})).rejects.toThrow('OPTIMIZER_RESPONSE_INVALID_OR_INFEASIBLE');
  });
  it('fails closed on network and persistence/unavailable HTTP failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('owned connection lost')));
    await expect(client.compute(valid.tenant_id, {})).rejects.toThrow('Route Optimizer');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 503 })));
    await expect(client.compute(valid.tenant_id, {})).rejects.toThrow('Route Optimizer');
  });
  it('sends the supplied complete request unchanged with dedicated internal authentication', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(valid), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const input = { input_snapshot: { stops: [{ stopId: randomUUID() }] }, input_hash: valid.input_hash };
    expect(await client.compute(valid.tenant_id, input)).toMatchObject({ persisted: true, route_plan_id: valid.route_plan_id });
    const options = fetcher.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(options.body))).toEqual(input);
    expect(options.headers).toHaveProperty('x-internal-service-token');
  });
});
