import { Injectable, Logger } from '@nestjs/common';
import type { DomainEventEnvelope } from '@logix/messaging';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../database/prisma.service.js';
import { mapDomainEventToAuditRecord } from './audit-event.mapper.js';

export const AUDIT_CONSUMER_NAME = 'audit-service-consumer';

function isPrismaUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

@Injectable()
export class AuditIngestionService {
  private readonly logger = new Logger(AuditIngestionService.name);

  constructor(private readonly prisma: PrismaService) {}

  async ingest(event: DomainEventEnvelope): Promise<'PROCESSED' | 'DUPLICATE'> {
    const mapped = mapDomainEventToAuditRecord(event);

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.inboxEvent.create({
          data: {
            tenantId: mapped.tenantId,
            eventId: mapped.sourceEventId,
            consumerName: AUDIT_CONSUMER_NAME,
            eventType: event.eventType.slice(0, 100),
            aggregateId: mapped.entityId,
            aggregateVersion: BigInt(event.aggregateVersion),
            outcome: 'PROCESSED',
          },
        });

        await tx.auditLog.create({
          data: {
            tenantId: mapped.tenantId,
            actorId: mapped.actorId,
            actorType: mapped.actorType,
            action: mapped.action,
            entityType: mapped.entityType,
            entityId: mapped.entityId,
            outcome: mapped.outcome,
            beforeData: mapped.beforeData as Prisma.InputJsonValue | undefined,
            afterData: mapped.afterData as Prisma.InputJsonValue | undefined,
            metadata: mapped.metadata as Prisma.InputJsonValue,
            correlationId: mapped.correlationId,
            causationId: mapped.causationId,
            sourceService: mapped.sourceService,
            sourceEventId: mapped.sourceEventId,
            occurredAt: mapped.occurredAt,
          },
        });
      });

      return 'PROCESSED';
    } catch (error) {
      if (isPrismaUniqueConstraintError(error)) {
        this.logger.debug({
          eventId: event.eventId,
          tenantId: event.tenantId,
          correlationId: event.correlationId,
          msg: 'Duplicate audit event ignored idempotently',
        });
        return 'DUPLICATE';
      }
      throw error;
    }
  }
}
