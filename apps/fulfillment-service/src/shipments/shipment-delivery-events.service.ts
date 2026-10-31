import { createHash } from 'node:crypto';
import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  SHIPMENT_EVENT,
  SHIPMENT_STATUS,
  deliveryResultEventSchema,
  type DeliveryResultPayload,
  type ShipmentStatus,
  type DomainEventEnvelope,
} from '@logix/messaging';
import { Prisma, type InboxEvent } from '../generated/prisma/client.js';
import { PrismaService } from '../database/prisma.service.js';
import { assertShipmentTransition } from './shipment.domain.js';
import { recordShipment } from './shipment.persistence.js';

const DELIVERY_RESULTS_CONSUMER = 'fulfillment-delivery-results';
const RETRY_INTERVAL_MS = 1_000;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 60_000;
const RETRY_BATCH_SIZE = 25;

type DeliveryResult = {
  toStatus: ShipmentStatus;
  shipmentEvent: string;
  reason: string | null;
  payload: DeliveryResultPayload;
};

function canonical(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map((item) => canonical(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function hash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function semanticResult(event: DomainEventEnvelope) {
  return {
    tenantId: event.tenantId,
    producer: event.producer,
    actorId: event.actorId,
    eventType: event.eventType,
    payload: event.payload,
  };
}

function parseDeliveryResult(event: DomainEventEnvelope): DeliveryResult {
  const parsed = deliveryResultEventSchema.parse(event);
  if (parsed.payload.occurredAt !== parsed.occurredAt)
    throw new Error('Delivery result occurrence time mismatch');

  return {
    toStatus: parsed.payload.outcome,
    shipmentEvent:
      parsed.payload.outcome === 'DELIVERED'
        ? SHIPMENT_EVENT.DELIVERED
        : SHIPMENT_EVENT.FAILED,
    reason: parsed.payload.reason,
    payload: parsed.payload,
  };
}

@Injectable()
export class ShipmentDeliveryEventsService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(ShipmentDeliveryEventsService.name);
  private retryTimer: NodeJS.Timeout | undefined;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    this.retryTimer = setInterval(() => {
      void this.retryDeferred().catch((error: unknown) =>
        this.logger.error(
          error instanceof Error
            ? error.message
            : 'Delivery result retry failed',
        ),
      );
    }, RETRY_INTERVAL_MS);
    this.retryTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.retryTimer) clearInterval(this.retryTimer);
  }

  async handle(event: DomainEventEnvelope): Promise<void> {
    if (
      event.eventType !== 'DeliveryCompleted' &&
      event.eventType !== 'DeliveryFailed'
    )
      return;
    const result = parseDeliveryResult(event);
    await this.persistOrApply(event, result);
  }

  async retryDeferred(): Promise<void> {
    const rows = await this.prisma.inboxEvent.findMany({
      where: {
        consumerName: DELIVERY_RESULTS_CONSUMER,
        outcome: 'DEFERRED',
        nextAttemptAt: { lte: new Date() },
        eventPayload: { not: Prisma.DbNull },
      },
      orderBy: { nextAttemptAt: 'asc' },
      take: RETRY_BATCH_SIZE,
    });
    for (const row of rows) {
      if (!row.eventPayload) continue;
      try {
        const event = JSON.parse(
          JSON.stringify(row.eventPayload),
        ) as DomainEventEnvelope;
        const result = parseDeliveryResult(event);
        await this.persistOrApply(event, result);
      } catch (error) {
        this.logger.error(
          error instanceof Error
            ? error.message
            : 'Deferred delivery result retry failed',
        );
      }
    }
  }

  private async persistOrApply(
    event: DomainEventEnvelope,
    result: DeliveryResult,
  ): Promise<void> {
    const key = `${result.payload.tripId}:${result.payload.stopId}`;
    const eventHash = hash(event);
    const semanticHash = hash(semanticResult(event));
    const diagnostic = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${event.tenantId}:${key}`},0))::text`,
      );

      const inboxKey = {
        consumerName_eventId: {
          consumerName: DELIVERY_RESULTS_CONSUMER,
          eventId: event.eventId,
        },
      };
      const existing = await tx.inboxEvent.findUnique({ where: inboxKey });
      let receipt: InboxEvent | undefined;
      if (existing) {
        if (existing.payloadHash !== eventHash)
          throw new Error('Delivery result event id payload conflict');
        if (existing.outcome !== 'DEFERRED') return;
        receipt = existing;
      }

      const semanticReceipt = await tx.inboxEvent.findFirst({
        where: {
          tenantId: event.tenantId,
          consumerName: DELIVERY_RESULTS_CONSUMER,
          semanticKey: key,
          eventId: { not: event.eventId },
          outcome: { in: ['APPLIED', 'DUPLICATE', 'DEFERRED'] },
        },
      });

      if (semanticReceipt) {
        const sameResult =
          semanticReceipt.eventPayload !== null &&
          hash(
            semanticResult(
              JSON.parse(
                JSON.stringify(semanticReceipt.eventPayload),
              ) as DomainEventEnvelope,
            ),
          ) === semanticHash;
        if (
          sameResult &&
          ['APPLIED', 'DUPLICATE'].includes(semanticReceipt.outcome)
        ) {
          await this.saveReceipt(tx, event, key, eventHash, receipt, {
            outcome: 'DUPLICATE',
          });
          return undefined;
        }
        if (!sameResult) {
          if (semanticReceipt.outcome === 'DEFERRED') {
            await tx.inboxEvent.update({
              where: { id: semanticReceipt.id },
              data: {
                outcome: 'CONFLICT',
                errorCode: 'CONFLICTING_TERMINAL_RESULT',
                lastError: 'CONFLICTING_TERMINAL_RESULT',
                processedAt: new Date(),
              },
            });
          }
          await this.saveReceipt(tx, event, key, eventHash, receipt, {
            outcome: 'CONFLICT',
            errorCode: 'CONFLICTING_TERMINAL_RESULT',
          });
          return 'CONFLICTING_TERMINAL_RESULT';
        }
      }

      const shipment = await tx.shipment.findFirst({
        where: {
          id: result.payload.shipmentId,
          tenantId: event.tenantId,
          deletedAt: null,
        },
      });
      if (!shipment) {
        await this.defer(tx, event, key, eventHash, receipt, {
          errorCode: 'SHIPMENT_NOT_YET_PROJECTED',
        });
        return receipt ? undefined : 'SHIPMENT_NOT_YET_PROJECTED';
      }
      if (shipment.assignedTripId !== result.payload.tripId) {
        await this.saveReceipt(tx, event, key, eventHash, receipt, {
          outcome: 'CONFLICT',
          errorCode: 'TRIP_SHIPMENT_BINDING_MISMATCH',
        });
        return 'TRIP_SHIPMENT_BINDING_MISMATCH';
      }
      if (shipment.status !== SHIPMENT_STATUS.DISPATCHED) {
        const terminalStatuses: string[] = [
          SHIPMENT_STATUS.DELIVERED,
          SHIPMENT_STATUS.FAILED,
          SHIPMENT_STATUS.CANCELED,
        ];
        if (!terminalStatuses.includes(shipment.status)) {
          await this.defer(tx, event, key, eventHash, receipt, {
            errorCode: 'SHIPMENT_DISPATCH_NOT_YET_PROJECTED',
          });
          return receipt ? undefined : 'SHIPMENT_DISPATCH_NOT_YET_PROJECTED';
        }
        await this.saveReceipt(tx, event, key, eventHash, receipt, {
          outcome: 'CONFLICT',
          errorCode: 'SHIPMENT_ALREADY_TERMINAL',
        });
        return 'SHIPMENT_ALREADY_TERMINAL';
      }

      const fromStatus = shipment.status;
      assertShipmentTransition(fromStatus, result.toStatus);
      const updated = await tx.shipment.update({
        where: { id: shipment.id, tenantId: event.tenantId },
        data: {
          status: result.toStatus,
          version: { increment: 1 },
          ...(result.toStatus === SHIPMENT_STATUS.DELIVERED && {
            deliveredAt: new Date(result.payload.occurredAt),
          }),
          ...(result.toStatus === SHIPMENT_STATUS.FAILED && {
            failedAt: new Date(result.payload.occurredAt),
            failureReason: result.reason,
          }),
        },
      });
      await recordShipment(
        tx,
        updated,
        fromStatus,
        result.shipmentEvent,
        {
          tenantId: event.tenantId,
          actorId: event.actorId,
          correlationId: event.correlationId,
          causationId: event.eventId,
        },
        result.reason,
      );
      await this.saveReceipt(tx, event, key, eventHash, receipt, {
        outcome: 'APPLIED',
      });
      return undefined;
    });
    if (diagnostic)
      this.logger.warn({
        eventId: event.eventId,
        tenantId: event.tenantId,
        errorCode: diagnostic,
      });
  }

  private async defer(
    tx: Prisma.TransactionClient,
    event: DomainEventEnvelope,
    semanticKey: string,
    payloadHash: string,
    receipt: InboxEvent | undefined,
    details: { errorCode: string },
  ) {
    const attemptCount = (receipt?.attemptCount ?? 0) + 1;
    const delay = Math.min(
      RETRY_MAX_MS,
      RETRY_BASE_MS * 2 ** Math.min(attemptCount - 1, 10),
    );
    await this.saveReceipt(tx, event, semanticKey, payloadHash, receipt, {
      outcome: 'DEFERRED',
      errorCode: details.errorCode,
      attemptCount,
      nextAttemptAt: new Date(Date.now() + delay),
    });
  }

  private async saveReceipt(
    tx: Prisma.TransactionClient,
    event: DomainEventEnvelope,
    semanticKey: string,
    payloadHash: string,
    receipt: InboxEvent | undefined,
    details: {
      outcome: string;
      errorCode?: string;
      attemptCount?: number;
      nextAttemptAt?: Date;
    },
  ) {
    const data = {
      tenantId: event.tenantId,
      eventId: event.eventId,
      consumerName: DELIVERY_RESULTS_CONSUMER,
      eventType: event.eventType,
      aggregateId: event.aggregateId,
      aggregateVersion: BigInt(event.aggregateVersion),
      eventPayload: event as unknown as Prisma.InputJsonValue,
      payloadHash,
      semanticKey,
      attemptCount: details.attemptCount ?? receipt?.attemptCount ?? 0,
      nextAttemptAt: details.nextAttemptAt ?? new Date(),
      lastError: details.errorCode ?? null,
      outcome: details.outcome,
      errorCode: details.errorCode ?? null,
      processedAt: new Date(),
    };
    if (receipt) {
      await tx.inboxEvent.update({
        where: { id: receipt.id },
        data,
      });
    } else {
      await tx.inboxEvent.create({ data });
    }
  }
}
