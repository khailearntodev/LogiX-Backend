import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BroadcastQueryService } from './broadcast-query.service.js';

@Injectable()
export class BroadcastReconcilerService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(BroadcastReconcilerService.name);
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private running: Promise<void> | undefined;

  constructor(
    private readonly queries: BroadcastQueryService,
    config: ConfigService,
  ) {
    this.enabled = config.getOrThrow<boolean>('DELIVERY_WORKER_ENABLED');
    this.intervalMs = config.getOrThrow<number>('DELIVERY_RECLAIM_INTERVAL_MS');
  }

  onModuleInit(): void {
    if (!this.enabled) return;
    this.stopped = false;
    this.schedule(this.intervalMs);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }

  async reconcile(): Promise<void> {
    const result = await this.queries.reconcileReadyBroadcasts();
    if (result.completed + result.partialFailed > 0) {
      this.logger.log({
        completed: result.completed,
        partialFailed: result.partialFailed,
        message: 'Reconciled READY broadcasts',
      });
    }
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.running = this.reconcile()
        .catch((error: unknown) => {
          this.logger.error(
            error instanceof Error
              ? error
              : 'Broadcast reconciliation failed',
          );
        })
        .finally(() => {
          this.running = undefined;
          if (!this.stopped) {
            this.schedule(this.intervalMs);
          }
        });
    }, delayMs);
  }
}
