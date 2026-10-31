import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service.js';
import { TripMembershipService } from './trip-membership.service.js';
import { TripDispatchService } from '../dispatch/trip-dispatch.service.js';

@Injectable()
export class TripRecoveryWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TripRecoveryWorker.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly memberships: TripMembershipService,
    private readonly config: ConfigService,
    private readonly dispatches: TripDispatchService,
  ) {}

  onModuleInit(): void {
    const interval = this.config.get<number>('RECOVERY_INTERVAL_MS') ?? 5000;
    this.timer = setInterval(
      () => void this.runOnce().catch((error) => this.logFailure(error)),
      interval,
    );
    this.timer.unref();
    void this.runOnce().catch((error) => this.logFailure(error));
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(): Promise<void> {
    const dispatches = await this.prisma.tripDispatch.findMany({
      where: { status: 'PENDING', nextAttemptAt: { lte: new Date() } },
      take: this.config.getOrThrow<number>('OUTBOX_BATCH_SIZE'),
      orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
    });
    for (const dispatch of dispatches) {
      try {
        await this.dispatches.resume(dispatch.tenantId, dispatch.idempotencyKey);
      } catch (error) {
        this.logFailure(error);
      }
    }
    const rows = await this.prisma.tripOperation.findMany({
      where: {
        status: { in: ['PENDING', 'COMPENSATING'] },
        nextAttemptAt: { lte: new Date() },
        OR: [{ lockedUntil: null }, { lockedUntil: { lt: new Date() } }],
      },
      orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }],
      take: 25,
      select: { id: true },
    });
    for (const operation of rows) {
      try {
        await this.memberships.resume(operation.id);
      } catch (error) {
        this.logger.error(
          error instanceof Error ? error.message : 'Trip operation recovery failed',
        );
      }
    }
  }

  private logFailure(error: unknown): void {
    this.logger.error(
      error instanceof Error ? error.message : 'Trip recovery scan failed',
    );
  }
}
