import { describe, expect, it } from 'vitest';
import { SHIPMENT_STATUS as S } from '@logix/messaging';
import {
  assertShipmentTransition,
  assertShipmentVersion,
} from './shipment.domain.js';

describe('Shipment lifecycle', () => {
  it.each([
    [S.PENDING_PICK, S.PICKING],
    [S.PICKING, S.READY_TO_SHIP],
    [S.READY_TO_SHIP, S.DISPATCHED],
    [S.DISPATCHED, S.DELIVERED],
    [S.DISPATCHED, S.FAILED],
  ])('allows %s → %s', (from, to) =>
    expect(assertShipmentTransition(from, to)).toMatch(/^Shipment/),
  );
  for (const from of Object.values(S))
    for (const to of Object.values(S)) {
      if (
        (from === S.PENDING_PICK && to === S.PICKING) ||
        (from === S.PICKING && to === S.READY_TO_SHIP) ||
        (from === S.READY_TO_SHIP && to === S.DISPATCHED) ||
        (from === S.DISPATCHED && [S.DELIVERED, S.FAILED].some((s) => s === to))
      )
        continue;
      it(`rejects ${from} → ${to}`, () =>
        expect(() => assertShipmentTransition(from, to)).toThrow());
    }
  it('accepts exact version', () =>
    expect(() => assertShipmentVersion(3n, 3)).not.toThrow());
  it('rejects stale version', () =>
    expect(() => assertShipmentVersion(3n, 2)).toThrow());
});
