import { InvalidStateTransitionError } from '@logix/errors';
import { ORDER_STATUS, ORDER_STATUSES, type OrderStatus } from './order-status.js';
import { assertTransition, canTransition, isTerminalStatus } from './order-state-machine.js';

const S = ORDER_STATUS;

const EXPECTED_VALID: ReadonlyArray<readonly [OrderStatus, OrderStatus]> = [
  [S.DRAFT, S.PENDING_STOCK],
  [S.DRAFT, S.CONFIRMED],
  [S.DRAFT, S.CANCELED],
  [S.PENDING_STOCK, S.CONFIRMED],
  [S.PENDING_STOCK, S.CANCELED],
  [S.CONFIRMED, S.PICKING],
  [S.CONFIRMED, S.CANCELED],
  [S.PICKING, S.READY_TO_SHIP],
  [S.PICKING, S.CANCELED],
  [S.READY_TO_SHIP, S.IN_DELIVERY],
  [S.READY_TO_SHIP, S.CANCELED],
  [S.IN_DELIVERY, S.COMPLETED],
  [S.IN_DELIVERY, S.DELIVERY_FAILED],
  [S.DELIVERY_FAILED, S.IN_DELIVERY],
];

const validKeys = new Set(EXPECTED_VALID.map(([from, to]) => `${from}->${to}`));

const allPairs = ORDER_STATUSES.flatMap((from) =>
  ORDER_STATUSES.map((to) => [from, to] as const),
);
const invalidPairs = allPairs.filter(([from, to]) => !validKeys.has(`${from}->${to}`));

describe('order state machine', () => {
  it('covers all 9 statuses (81 pairs)', () => {
    expect(ORDER_STATUSES).toHaveLength(9);
    expect(allPairs).toHaveLength(81);
    expect(invalidPairs).toHaveLength(81 - EXPECTED_VALID.length);
  });

  it.each(EXPECTED_VALID)('allows %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(() => assertTransition(from, to)).not.toThrow();
  });

  it.each(invalidPairs)('rejects %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
    expect(() => assertTransition(from, to)).toThrow(InvalidStateTransitionError);
  });

  it('marks only COMPLETED and CANCELED as terminal', () => {
    const terminal = ORDER_STATUSES.filter(isTerminalStatus);
    expect(terminal).toEqual([S.COMPLETED, S.CANCELED]);
  });
});
