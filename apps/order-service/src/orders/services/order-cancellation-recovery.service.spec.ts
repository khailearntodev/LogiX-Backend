import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../database/prisma.service.js';
import { OrderCommandService } from './order-command.service.js';
import { OrderCancellationRecoveryService } from './order-cancellation-recovery.service.js';
import { ORDER_STATUS } from '../domain/order-status.js';

describe('OrderCancellationRecoveryService', () => {
  async function setup() {
    const prisma = { salesOrder: { findMany: vi.fn().mockResolvedValue([]) } };
    const commands = { completeCancellation: vi.fn().mockResolvedValue({}) };
    const config = new ConfigService({
      OUTBOX_BATCH_SIZE: 20,
      OUTBOX_INTERVAL_MS: 1000,
    });
    const module = await Test.createTestingModule({
      providers: [
        OrderCancellationRecoveryService,
        { provide: PrismaService, useValue: prisma },
        { provide: OrderCommandService, useValue: commands },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();
    return {
      service: module.get(OrderCancellationRecoveryService),
      prisma,
      commands,
    };
  }

  it('selects only persisted pending intents and completes each with its owning tenant', async () => {
    const { service, prisma, commands } = await setup();
    prisma.salesOrder.findMany.mockResolvedValue([
      { id: 'order-a', tenantId: 'tenant-a' },
      { id: 'order-b', tenantId: 'tenant-b' },
    ]);
    await service.recover();
    expect(prisma.salesOrder.findMany).toHaveBeenCalledWith({
      where: {
        cancellationRequestedAt: { not: null },
        deletedAt: null,
        status: { not: ORDER_STATUS.CANCELED },
      },
      orderBy: [{ cancellationRequestedAt: 'asc' }, { id: 'asc' }],
      take: 20,
    });
    expect(commands.completeCancellation.mock.calls).toEqual([
      ['tenant-a', 'order-a'],
      ['tenant-b', 'order-b'],
    ]);
  });

  it('continues other intents after a logged upstream failure and retries on the next scan', async () => {
    const { service, prisma, commands } = await setup();
    prisma.salesOrder.findMany.mockResolvedValue([
      {
        id: 'order-a',
        tenantId: 'tenant-a',
        cancellationCorrelationId: 'correlation-a',
      },
      { id: 'order-b', tenantId: 'tenant-b' },
    ]);
    commands.completeCancellation.mockRejectedValueOnce(
      new Error('Inventory unavailable'),
    );
    await service.recover();
    await service.recover();
    expect(commands.completeCancellation).toHaveBeenCalledTimes(4);
    expect(commands.completeCancellation.mock.calls[2]).toEqual([
      'tenant-a',
      'order-a',
    ]);
  });

  it('cancels the scheduled recovery when the application shuts down', async () => {
    vi.useFakeTimers();
    try {
      const { service, prisma } = await setup();
      service.onModuleInit();
      await service.onModuleDestroy();
      await vi.advanceTimersByTimeAsync(2000);
      expect(prisma.salesOrder.findMany).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
