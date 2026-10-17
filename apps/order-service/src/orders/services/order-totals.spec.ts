import { calculateOrderTotals } from './order-totals.js';

describe('calculateOrderTotals', () => {
  it('sums quantity, weight and volume with decimal precision', () => {
    const totals = calculateOrderTotals([
      { quantity: '10', unitWeight: '1.000', unitVolume: '0.010000' },
      { quantity: '5', unitWeight: '5.000', unitVolume: '0.020000' },
    ]);

    expect(totals.totalQuantity.toFixed(3)).toBe('15.000');
    expect(totals.totalWeight.toFixed(3)).toBe('35.000');
    expect(totals.totalVolume.toFixed(6)).toBe('0.200000');
  });

  it('avoids binary floating point drift', () => {
    const totals = calculateOrderTotals([
      { quantity: '0.1', unitWeight: '1', unitVolume: '1' },
      { quantity: '0.2', unitWeight: '1', unitVolume: '1' },
    ]);

    expect(totals.totalQuantity.toString()).toBe('0.3');
  });

  it('rounds half-up to the column scales', () => {
    const totals = calculateOrderTotals([
      { quantity: '1.005', unitWeight: '1.001', unitVolume: '0.0000005' },
    ]);

    expect(totals.totalWeight.toFixed(3)).toBe('1.006');
    expect(totals.totalVolume.toFixed(6)).toBe('0.000001');
  });

  it('returns zero totals for no lines', () => {
    const totals = calculateOrderTotals([]);

    expect(totals.totalQuantity.isZero()).toBe(true);
    expect(totals.totalWeight.isZero()).toBe(true);
    expect(totals.totalVolume.isZero()).toBe(true);
  });
});
