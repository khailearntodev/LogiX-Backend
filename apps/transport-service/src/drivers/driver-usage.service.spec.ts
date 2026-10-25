import { randomUUID } from 'node:crypto';
import type { PrismaService } from '../database/prisma.service.js';
import { DriverUsageService } from './driver-usage.service.js';

describe('Driver historical reference lookup', () => {
  const tenantId = randomUUID(),
    driverId = randomUUID();
  it.each([null, { id: randomUUID() }])(
    'queries ALL references without lifecycle/soft-delete filters: %j',
    async (reference) => {
      const findFirst = vi.fn().mockResolvedValue(reference);
      const service = new DriverUsageService({
        deliveryTrip: { findFirst },
      } as unknown as PrismaService);
      expect(await service.usage(tenantId, driverId)).toEqual({
        tenantId,
        driverId,
        used: reference !== null,
      });
      expect(findFirst).toHaveBeenCalledExactlyOnceWith({
        where: { tenantId, driverId },
        select: { id: true },
      });
    },
  );
  it('propagates database failure instead of returning unused', async () => {
    const findFirst = vi.fn().mockRejectedValue(new Error('database offline'));
    const service = new DriverUsageService({
      deliveryTrip: { findFirst },
    } as unknown as PrismaService);
    await expect(service.usage(tenantId, driverId)).rejects.toThrow(
      'database offline',
    );
  });
});
