import { describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service.js';
import { ShipmentDispatchService } from './shipment-dispatch.service.js';
import { ShipmentRecoveryService } from './shipment-recovery.service.js';
import { ShipmentDispatchBatchService } from './shipment-dispatch-batch.service.js';

describe('Shipment recovery scheduling', () => {
  it('continues after failure and schedules persisted bounded backoff without discarding unknown decisions', async () => {
    const intents = [
      { id: 'request-a', tenantId: 'tenant', shipmentId: 'a', attemptCount: 0 },
      { id: 'request-b', tenantId: 'tenant', shipmentId: 'b', attemptCount: 3 },
    ];
    const prisma = {
      shipmentDispatchBatch: { findMany: vi.fn().mockResolvedValue([]) },
      shipmentDispatchIntent: {
        findMany: vi.fn(async () => intents),
        updateMany: vi.fn(),
      },
    };
    const dispatch = {
      complete: vi
        .fn()
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValue(undefined),
    };
    const config = new ConfigService({
      OUTBOX_BATCH_SIZE: 20,
      OUTBOX_RETRY_BASE_MS: 100,
      OUTBOX_RETRY_MAX_MS: 1000,
    });
    const service = new ShipmentRecoveryService(
      prisma as unknown as PrismaService,
      dispatch as unknown as ShipmentDispatchService,
      config,
      {} as ShipmentDispatchBatchService,
    );
    await service.recover();
    expect(dispatch.complete).toHaveBeenCalledTimes(2);
    expect(prisma.shipmentDispatchIntent.updateMany).toHaveBeenCalledWith({
      where: { id: 'request-a', status: 'PENDING' },
      data: { attemptCount: { increment: 1 }, nextAttemptAt: expect.any(Date) },
    });
    expect(prisma.shipmentDispatchIntent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: 'PENDING', batchId: null, nextAttemptAt: { lte: expect.any(Date) } },
      }),
    );
  });
});
