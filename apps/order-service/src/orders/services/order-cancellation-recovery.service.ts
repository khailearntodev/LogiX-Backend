import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../database/prisma.service.js';
import { OrderCommandService } from './order-command.service.js';
import { ORDER_STATUS } from '../domain/order-status.js';

@Injectable()
export class OrderCancellationRecoveryService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(OrderCancellationRecoveryService.name);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private stopped = true;

  constructor(
    private readonly prisma: PrismaService,
    private readonly commands: OrderCommandService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    this.stopped = false;
    this.schedule();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }

  async recover(): Promise<void> {
    const orders = await this.prisma.salesOrder.findMany({
      where: {
        cancellationRequestedAt: { not: null },
        deletedAt: null,
        status: { not: ORDER_STATUS.CANCELED },
      },
      orderBy: [{ cancellationRequestedAt: 'asc' }, { id: 'asc' }],
      take: this.config.getOrThrow<number>('OUTBOX_BATCH_SIZE'),
    });
    for (const order of orders) {
      try {
        await this.commands.completeCancellation(order.tenantId, order.id);
      } catch (error) {
        this.logger.error({
          orderId: order.id,
          tenantId: order.tenantId,
          correlationId: order.cancellationCorrelationId,
          error:
            error instanceof Error
              ? error.message
              : 'Cancellation recovery failed',
        });
      }
    }
  }

  private schedule(): void {
    this.timer = setTimeout(() => {
      this.running = this.recover()
        .catch((error: unknown) =>
          this.logger.error(
            error instanceof Error ? error : 'Cancellation recovery failed',
          ),
        )
        .finally(() => {
          this.running = undefined;
          if (!this.stopped) this.schedule();
        });
    }, this.config.getOrThrow<number>('OUTBOX_INTERVAL_MS'));
  }
}
