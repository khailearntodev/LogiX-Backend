import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { assertPermutation, coordinate, decimal, routeHash } from './route-domain.js';
import { RoutePreviewTokenService } from './route-preview-token.service.js';
import { approveTripRouteSchema, manualTripRouteSchema, overrideTripRouteSchema, tripRoutePreviewSchema } from '@logix/messaging';

describe('Phase 3 route contracts and pure rules', () => {
  const ids = [randomUUID(), randomUUID()];
  it('requires a complete unique permutation and permits swaps', () => {
    expect(() => assertPermutation([...ids].reverse(), ids)).not.toThrow();
    for (const invalid of [[], [ids[0]], [ids[0], ids[0]], [...ids, randomUUID()], [ids[0], randomUUID()]])
      expect(() => assertPermutation(invalid, ids)).toThrow('ROUTE_REQUIRES_FULL_STOP_PERMUTATION');
  });
  it.each([['0', 3, '0.000'], ['1.001', 3, '1.001'], ['0.000001', 6, '0.000001']])(
    'normalizes %s without binary floating point', (value, scale, expected) => {
      expect(decimal(value, scale)).toBe(expected);
    },
  );
  it.each([null, 0, '-1', 'NaN', '1e2', '0.0001', '1000000000000000'])(
    'rejects invalid or unsupported weight %s', (value) => expect(() => decimal(value, 3)).toThrow(),
  );
  it('rejects missing or zero capacity', () => {
    expect(() => decimal('0', 3, true)).toThrow();
    expect(() => decimal(undefined, 6, true)).toThrow();
  });
  it('checks explicit latitude and longitude ranges', () => {
    expect(coordinate('-90', 90)).toBe('-90.000000');
    expect(coordinate('180', 180)).toBe('180.000000');
    expect(() => coordinate('91', 90)).toThrow();
    expect(() => coordinate('181', 180)).toThrow();
    expect(() => coordinate('1.0000001', 180)).toThrow();
  });
  it('uses the approved canonical hash golden vector', () => {
    expect(routeHash({ b: 2, a: 1 })).toBe('43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777');
  });
  it('requires strict bindings, explicit confirmation and paired override reason/order', () => {
    const base = { expectedVersion: 1, planId: randomUUID(), planVersion: 1, inputHash: 'a'.repeat(64) };
    expect(tripRoutePreviewSchema.safeParse(base).success).toBe(true);
    expect(tripRoutePreviewSchema.safeParse({ ...base, orderedStopIds: ids }).success).toBe(false);
    expect(tripRoutePreviewSchema.safeParse({ ...base, orderedStopIds: ids, reason: '  ' }).success).toBe(false);
    expect(approveTripRouteSchema.safeParse({ ...base, requestId: randomUUID(), previewToken: 'signed', confirmed: false }).success).toBe(false);
    expect(overrideTripRouteSchema.safeParse({ ...base, requestId: randomUUID(), previewToken: 'signed', confirmed: true, orderedStopIds: ids, reason: ' re-order ' }).data?.reason).toBe('re-order');
    expect(manualTripRouteSchema.safeParse({ requestId: randomUUID(), expectedTripVersion: 1, orderedStopIds: [ids[0], ids[0]] }).success).toBe(false);
  });
});

describe('Route signed previews', () => {
  const config = new ConfigService({
    TRIP_CANCEL_PREVIEW_SECRET: 'preview-purpose-separated-key-'.repeat(3),
    JWT_SECRET: 'user-key-'.repeat(8), INTERNAL_SERVICE_JWT_SECRET: 'internal-key-'.repeat(8),
  });
  const tokens = new RoutePreviewTokenService(config);
  const binding = {
    tenantId: randomUUID(), actorId: randomUUID(), tripId: randomUUID(),
    action: 'APPROVE' as const, payloadHash: 'b'.repeat(64),
  };
  afterEach(() => vi.useRealTimers());
  it('accepts exact context and rejects tampering, wrong actor, tenant, action, trip and hash', () => {
    const issued = tokens.issue(binding);
    expect(() => tokens.verify(issued.previewToken, binding)).not.toThrow();
    expect(() => tokens.verify(`${issued.previewToken}bad`, binding)).toThrow('ROUTE_PREVIEW');
    for (const mutation of [
      { tenantId: randomUUID() }, { actorId: randomUUID() }, { tripId: randomUUID() },
      { action: 'OVERRIDE' as const }, { payloadHash: 'c'.repeat(64) },
    ]) expect(() => tokens.verify(issued.previewToken, { ...binding, ...mutation })).toThrow('ROUTE_PREVIEW');
  });
  it('expires after the existing five-minute preview TTL', () => {
    vi.useFakeTimers();
    const issued = tokens.issue(binding);
    vi.advanceTimersByTime(300000);
    expect(() => tokens.verify(issued.previewToken, binding)).toThrow('ROUTE_PREVIEW');
  });
  it('rejects authentication secret reuse', () => {
    expect(() => new RoutePreviewTokenService(new ConfigService({
      TRIP_CANCEL_PREVIEW_SECRET: 'same', JWT_SECRET: 'same', INTERNAL_SERVICE_JWT_SECRET: 'different',
    }))).toThrow('distinct');
  });
});
