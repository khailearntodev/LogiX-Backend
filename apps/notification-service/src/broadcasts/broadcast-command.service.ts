import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../database/prisma.service.js';
import {
  BROADCAST_AGGREGATE_TYPE,
  BROADCAST_COMMAND_EVENT_TYPE,
  BROADCAST_STATUSES,
  NOTIFICATION_TYPES,
} from '../notifications/notification.constants.js';
import { NotificationWriterService } from '../notifications/notification-writer.service.js';
import {
  BroadcastIdempotencyConflictError,
  canonicalizeBroadcastAudience,
  hashBroadcastPayload,
  type BroadcastCommandPayload,
  type CreateBroadcastInput,
  type EnqueueBroadcastResult,
} from './broadcast.types.js';

@Injectable()
export class BroadcastCommandService {
  private readonly logger = new Logger(BroadcastCommandService.name);
  private readonly broadcastTopic: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly writer: NotificationWriterService,
    config: ConfigService,
  ) {
    this.broadcastTopic = config.getOrThrow<string>(
      'KAFKA_NOTIFICATION_BROADCAST_TOPIC',
    );
  }

  async enqueue(input: CreateBroadcastInput): Promise<EnqueueBroadcastResult> {
    const canonicalAudience = canonicalizeBroadcastAudience(input.audience);
    const payloadHash = hashBroadcastPayload({
      title: input.title,
      body: input.body,
      severity: input.severity,
      audience: canonicalAudience,
      link: input.link,
    });

    const existing = await this.prisma.notificationBroadcast.findUnique({
      where: {
        tenantId_idempotencyKey: {
          tenantId: input.tenantId,
          idempotencyKey: input.idempotencyKey,
        },
      },
      select: { id: true, status: true, payloadHash: true },
    });
    if (existing) {
      return this.resolveExisting(existing, payloadHash);
    }

    const requestedCount =
      canonicalAudience.kind === 'USERS'
        ? canonicalAudience.userIds.length
        : null;

    try {
      const createdResult = await this.prisma.$transaction(async (tx) => {
        const insideTxExisting = await tx.notificationBroadcast.findUnique({
          where: {
            tenantId_idempotencyKey: {
              tenantId: input.tenantId,
              idempotencyKey: input.idempotencyKey,
            },
          },
          select: { id: true, status: true, payloadHash: true },
        });
        if (insideTxExisting) {
          return this.resolveExisting(insideTxExisting, payloadHash);
        }

        const notification = await this.writer.createNotification(tx, {
          tenantId: input.tenantId,
          type: NOTIFICATION_TYPES.ADMIN_BROADCAST,
          title: input.title,
          body: input.body,
          severity: input.severity,
          entityType: null,
          entityId: null,
          sourceEventId: null,
          deduplicationKey: null,
          link: input.link,
          data: {
            senderId: input.actorId,
            audience: canonicalAudience,
          },
        });

        const broadcastId = randomUUID();
        const requestedAt = notification.createdAt.toISOString();

        await tx.notificationBroadcast.create({
          data: {
            id: broadcastId,
            tenantId: input.tenantId,
            notificationId: notification.id,
            createdBy: input.actorId,
            idempotencyKey: input.idempotencyKey,
            payloadHash,
            audience: canonicalAudience as Prisma.InputJsonValue,
            status: BROADCAST_STATUSES.QUEUED,
            requestedCount,
            resolvedCount: 0,
          },
        });

        const commandPayload: BroadcastCommandPayload = {
          broadcastId,
          notificationId: notification.id,
          tenantId: input.tenantId,
          actorId: input.actorId,
          audience: canonicalAudience,
          snapshotAt: requestedAt,
          requestedAt,
        };

        await tx.outboxEvent.create({
          data: {
            id: randomUUID(),
            tenantId: input.tenantId,
            topic: this.broadcastTopic,
            aggregateType: BROADCAST_AGGREGATE_TYPE,
            aggregateId: broadcastId,
            aggregateVersion: 1n,
            eventType: BROADCAST_COMMAND_EVENT_TYPE,
            eventVersion: 1,
            correlationId: input.correlationId,
            causationId: input.correlationId,
            payload: commandPayload as Prisma.InputJsonValue,
            occurredAt: notification.createdAt,
          },
        });

        return {
          id: broadcastId,
          status: BROADCAST_STATUSES.QUEUED,
          deduplicated: false,
        };
      });

      this.logger.log({
        tenantId: input.tenantId,
        actorId: input.actorId,
        broadcastId: createdResult.id,
        status: createdResult.status,
        deduplicated: createdResult.deduplicated,
        correlationId: input.correlationId,
      });

      return createdResult;
    } catch (error) {
      if (!isIdempotencyConstraintViolation(error)) {
        throw error;
      }

      const raced = await this.prisma.notificationBroadcast.findUnique({
        where: {
          tenantId_idempotencyKey: {
            tenantId: input.tenantId,
            idempotencyKey: input.idempotencyKey,
          },
        },
        select: { id: true, status: true, payloadHash: true },
      });
      if (!raced) throw error;
      return this.resolveExisting(raced, payloadHash);
    }
  }

  private resolveExisting(
    existing: { id: string; status: string; payloadHash: string },
    payloadHash: string,
  ): EnqueueBroadcastResult {
    if (existing.payloadHash !== payloadHash) {
      throw new BroadcastIdempotencyConflictError();
    }
    return {
      id: existing.id,
      status: existing.status,
      deduplicated: true,
    };
  }
}

function isIdempotencyConstraintViolation(error: unknown): boolean {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== 'P2002'
  ) {
    return false;
  }

  const meta = error.meta as Record<string, unknown> | undefined;
  if (!meta) return false;

  const target = meta.target;
  if (target === 'ux_notification_broadcasts_idempotency') {
    return true;
  }

  const driverError = meta.driverAdapterError as Record<string, unknown> | undefined;
  const cause = driverError?.cause as Record<string, unknown> | undefined;
  const constraint = cause?.constraint as Record<string, unknown> | undefined;
  if (constraint?.index === 'ux_notification_broadcasts_idempotency') {
    return true;
  }

  const rawFields = Array.isArray(target)
    ? target
    : Array.isArray(constraint?.fields)
      ? constraint.fields
      : [];
  const fields = new Set(
    rawFields.filter((value): value is string => typeof value === 'string'),
  );
  return (
    (fields.has('tenant_id') || fields.has('tenantId')) &&
    (fields.has('idempotency_key') || fields.has('idempotencyKey'))
  );
}
