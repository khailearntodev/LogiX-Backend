import {
  Injectable,
  Logger,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service.js';
import { ShipmentDispatchService } from './shipment-dispatch.service.js';
import { INTENT_STATUS } from './shipment.domain.js';
import { outboxRetryDelay } from '@logix/messaging';
import { ShipmentDispatchBatchService } from './shipment-dispatch-batch.service.js';

@Injectable()
export class ShipmentRecoveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ShipmentRecoveryService.name);
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private stopped = true;
  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatch: ShipmentDispatchService,
    private readonly config: ConfigService,
    private readonly batches: ShipmentDispatchBatchService,
  ) {}
  onModuleInit() {
    this.stopped = false;
    this.schedule();
  }
  async onModuleDestroy() {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }
  async recover() {
    const batches = await this.prisma.shipmentDispatchBatch.findMany({
      where: { status: INTENT_STATUS.PENDING, nextAttemptAt: { lte: new Date() } },
      take: this.config.getOrThrow<number>('OUTBOX_BATCH_SIZE'),
      orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
    });
    for (const batch of batches) {
      try {
        await this.batches.complete(batch.tenantId, batch.id);
      } catch {
        await this.prisma.shipmentDispatchBatch.updateMany({
          where: { id: batch.id, status: INTENT_STATUS.PENDING },
          data: {
            attemptCount: { increment: 1 }, lastError: 'BATCH_RECOVERY_PENDING',
            nextAttemptAt: new Date(Date.now() + outboxRetryDelay(batch.attemptCount + 1,
              this.config.getOrThrow<number>('OUTBOX_RETRY_BASE_MS'), this.config.getOrThrow<number>('OUTBOX_RETRY_MAX_MS'))),
          },
        });
      }
    }
    const intents = await this.prisma.shipmentDispatchIntent.findMany({
      where: {
        status: INTENT_STATUS.PENDING,
        batchId: null,
        nextAttemptAt: { lte: new Date() },
      },
      orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
      take: this.config.getOrThrow<number>('OUTBOX_BATCH_SIZE'),
    });
    for (const intent of intents) {
      try {
        await this.dispatch.complete(intent.tenantId, intent.shipmentId);
      } catch (error) {
        await this.prisma.shipmentDispatchIntent.updateMany({
          where: { id: intent.id, status: INTENT_STATUS.PENDING },
          data: {
            attemptCount: { increment: 1 },
            nextAttemptAt: new Date(
              Date.now() +
                outboxRetryDelay(
                  intent.attemptCount + 1,
                  this.config.getOrThrow<number>('OUTBOX_RETRY_BASE_MS'),
                  this.config.getOrThrow<number>('OUTBOX_RETRY_MAX_MS'),
                ),
            ),
          },
        });
        this.logger.error({
          shipmentId: intent.shipmentId,
          requestId: intent.id,
          error:
            error instanceof Error ? error.message : 'Dispatch recovery failed',
        });
      }
    }
  }
  private schedule() {
    this.timer = setTimeout(() => {
      this.running = this.recover()
        .catch((error: unknown) => this.logger.error(error))
        .finally(() => {
          this.running = undefined;
          if (!this.stopped) this.schedule();
        });
    }, this.config.getOrThrow<number>('OUTBOX_INTERVAL_MS'));
  }
}
