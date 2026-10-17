import { randomUUID } from 'node:crypto';
import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  INTERNAL_SERVICE_TOKEN_HEADER,
  signInternalServiceToken,
} from '@logix/auth';
import { ServiceId } from '@logix/common';
import { z } from 'zod';
import { PrismaService } from '../../database/prisma.service.js';
import {
  ReservationService,
  RESERVATION_STATUS,
} from './reservation.service.js';

const INTERNAL_TOKEN_TTL_SECONDS = 60;
const RECONCILE_REQUEST_TIMEOUT_MS = 10_000;
const decisionSchema = z.object({
  decision: z.enum(['ACKNOWLEDGE', 'RELEASE', 'KEEP']),
});

@Injectable()
export class ReservationReconcilerService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(ReservationReconcilerService.name);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private running: Promise<void> | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly reservations: ReservationService,
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

  async reconcile(): Promise<void> {
    const groups = await this.prisma.reservationGroup.findMany({
      where: {
        status: RESERVATION_STATUS.ACTIVE,
        acknowledgedAt: null,
        deletedAt: null,
        reservedAt: {
          lte: new Date(
            Date.now() -
              this.config.getOrThrow<number>('RESERVATION_RECONCILE_AGE_MS'),
          ),
        },
      },
      include: { reservations: true },
      orderBy: [{ reservedAt: 'asc' }, { id: 'asc' }],
      take: this.config.getOrThrow<number>('OUTBOX_BATCH_SIZE'),
    });
    for (const group of groups) {
      const correlationId = randomUUID();
      try {
        const orderVersion = Number(group.orderVersion);
        if (!Number.isSafeInteger(orderVersion))
          throw new Error('Unsafe reservation order version');
        const token = signInternalServiceToken({
          secret: this.config.getOrThrow<string>('INTERNAL_SERVICE_JWT_SECRET'),
          service: ServiceId.INVENTORY_SERVICE,
          audience: ServiceId.ORDER_SERVICE,
          tenantId: group.tenantId,
          ttlSeconds: INTERNAL_TOKEN_TTL_SECONDS,
        });
        const response = await fetch(
          `${this.config.getOrThrow<string>('ORDER_SERVICE_URL').replace(/\/+$/, '')}/internal/orders/reconcile-reservation`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-correlation-id': correlationId,
              [INTERNAL_SERVICE_TOKEN_HEADER]: token,
            },
            body: JSON.stringify({
              reservationGroupId: group.id,
              orderId: group.orderId,
              warehouseId: group.warehouseId,
              orderVersion,
              lines: group.reservations.map((line) => ({
                orderLineId: line.orderLineId,
                productId: line.productId,
                quantity: line.quantity.toFixed(3),
              })),
            }),
            signal: AbortSignal.timeout(RECONCILE_REQUEST_TIMEOUT_MS),
          },
        );
        if (!response.ok)
          throw new Error(`Order reconciliation rejected: ${response.status}`);
        const result = decisionSchema.parse(await response.json());
        if (result.decision === 'RELEASE') {
          await this.reservations.release(
            group.orderId,
            { tenantId: group.tenantId, correlationId },
            group.id,
          );
        } else if (result.decision === 'ACKNOWLEDGE') {
          await this.prisma.reservationGroup.updateMany({
            where: {
              tenantId: group.tenantId,
              id: group.id,
              status: RESERVATION_STATUS.ACTIVE,
              acknowledgedAt: null,
            },
            data: { acknowledgedAt: new Date(), version: { increment: 1 } },
          });
        } else {
          this.logger.warn(
            {
              reservationGroupId: group.id,
              orderId: group.orderId,
              correlationId,
            },
            'Order retains reservation while cancellation is being recovered',
          );
        }
      } catch (error) {
        this.logger.error(
          {
            reservationGroupId: group.id,
            orderId: group.orderId,
            correlationId,
            error:
              error instanceof Error
                ? error.message
                : 'Reservation reconciliation failed',
          },
          'Reservation kept; missing confirmation never authorizes release',
        );
      }
    }
  }

  private schedule(): void {
    this.timer = setTimeout(() => {
      this.running = this.reconcile()
        .catch((error: unknown) =>
          this.logger.error(
            error instanceof Error ? error : 'Reconciler query failed',
          ),
        )
        .finally(() => {
          this.running = undefined;
          if (!this.stopped) this.schedule();
        });
    }, this.config.getOrThrow<number>('RESERVATION_RECONCILE_INTERVAL_MS'));
  }
}
