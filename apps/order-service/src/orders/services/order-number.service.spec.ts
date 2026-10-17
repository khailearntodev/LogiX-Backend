import type { Prisma } from '../../generated/prisma/client.js';
import {
  OrderNumberService,
  formatOrderNumber,
  formatOrderPeriod,
} from './order-number.service.js';

describe('formatOrderPeriod', () => {
  it('uses the Asia/Ho_Chi_Minh business day', () => {
    expect(formatOrderPeriod(new Date('2025-01-31T16:59:59.999Z'))).toBe(
      '20250131',
    );
    expect(formatOrderPeriod(new Date('2025-01-31T17:00:00.000Z'))).toBe(
      '20250201',
    );
  });
});

describe('formatOrderNumber', () => {
  it('zero-pads the sequence', () => {
    expect(formatOrderNumber('20250201', 7n)).toBe('SO-20250201-000007');
  });

  it('keeps sequences longer than the pad width intact', () => {
    expect(formatOrderNumber('20250201', 1234567n)).toBe('SO-20250201-1234567');
  });
});

describe('OrderNumberService', () => {
  it('formats the value returned by the sequence upsert', async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ last_value: 42n }]),
    } as unknown as Prisma.TransactionClient;

    const value = await new OrderNumberService().next(
      tx,
      '11111111-1111-4111-8111-111111111111',
      new Date('2025-03-10T03:00:00.000Z'),
    );

    expect(value).toBe('SO-20250310-000042');
  });

  it('fails loudly when the upsert returns no row', async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
    } as unknown as Prisma.TransactionClient;

    await expect(
      new OrderNumberService().next(
        tx,
        '11111111-1111-4111-8111-111111111111',
        new Date(),
      ),
    ).rejects.toThrow('Order number sequence upsert returned no row');
  });
});
