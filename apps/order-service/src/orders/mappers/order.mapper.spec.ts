import { Prisma } from '../../generated/prisma/client.js';
import {
  addressFixture,
  customerFixture,
  salesOrderFixture,
  warehouseFixture,
} from '../../../test/fixtures/order.fixtures.js';
import {
  buildAddressSnapshot,
  buildCustomerSnapshot,
  buildWarehouseSnapshot,
  toOrderDetailView,
  toOrderDraftPayload,
} from './order.mapper.js';

const containsUnsafeValue = (value: unknown): boolean => {
  if (typeof value === 'bigint' || value instanceof Prisma.Decimal) {
    return true;
  }
  if (value instanceof Date || value === null || typeof value !== 'object') {
    return false;
  }
  return Object.values(value).some(containsUnsafeValue);
};

describe('order mapper', () => {
  it('exposes decimals as fixed-scale strings and version as number', () => {
    const view = toOrderDetailView(salesOrderFixture());

    expect(view.totalQuantity).toBe('10.000');
    expect(view.totalWeight).toBe('10.000');
    expect(view.totalVolume).toBe('0.100000');
    expect(view.version).toBe(1);
    expect(view.lines[0]?.quantity).toBe('10.000');
    expect(view.lines[0]?.unitVolume).toBe('0.010000');
    expect(containsUnsafeValue(view)).toBe(false);
    expect(() => JSON.stringify(view)).not.toThrow();
  });

  it('sorts lines by line number', () => {
    const base = salesOrderFixture();
    const [line] = base.lines;
    if (!line) {
      throw new Error('fixture must contain a line');
    }
    const order = salesOrderFixture({
      lines: [
        { ...line, id: 'second', lineNumber: 2 },
        { ...line, id: 'first', lineNumber: 1 },
      ],
    });

    expect(toOrderDetailView(order).lines.map((l) => l.id)).toEqual([
      'first',
      'second',
    ]);
    expect(
      toOrderDraftPayload(order).orderLines.map((l) => l.lineNumber),
    ).toEqual([1, 2]);
  });

  it('rejects corrupted snapshot columns instead of masking them', () => {
    expect(() =>
      toOrderDetailView(salesOrderFixture({ customerSnapshot: null })),
    ).toThrow('Corrupted order snapshot column: customer_snapshot');
  });

  it('builds event payloads without BigInt or Decimal values', () => {
    const payload = toOrderDraftPayload(salesOrderFixture());

    expect(containsUnsafeValue(payload)).toBe(false);
    expect(payload.orderLines).toEqual([
      {
        lineNumber: 1,
        productId: salesOrderFixture().lines[0]?.productId,
        quantity: '10.000',
      },
    ]);
  });

  it('captures Master Data versions in snapshots', () => {
    expect(buildCustomerSnapshot(customerFixture()).customerVersion).toBe(3);
    expect(buildAddressSnapshot(addressFixture()).addressVersion).toBe(2);
    expect(buildWarehouseSnapshot(warehouseFixture()).warehouseVersion).toBe(1);
  });
});
