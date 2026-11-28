import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ServiceId } from '@logix/common';
import type { DomainEventEnvelope } from '@logix/messaging';
import type { PrismaService } from '../database/prisma.service.js';
import {
  AUDIT_CONSUMER_NAME,
  AuditIngestionService,
} from './audit-ingestion.service.js';

function createSampleEvent(eventId = randomUUID()): DomainEventEnvelope {
  const correlationId = randomUUID();
  return {
    eventId,
    eventType: 'OrderConfirmed',
    eventVersion: 1,
    occurredAt: '2026-11-24T12:00:00.000Z',
    producer: ServiceId.ORDER_SERVICE,
    tenantId: randomUUID(),
    actorId: randomUUID(),
    correlationId,
    causationId: correlationId,
    aggregateType: 'SalesOrder',
    aggregateId: randomUUID(),
    aggregateVersion: 3,
    payload: {
      orderId: randomUUID(),
      orderNumber: 'SO-2026-0001',
      secretToken: 'must-not-be-saved',
    },
  };
}

describe('AuditIngestionService', () => {
  it('persists InboxEvent and redacted AuditLog atomically on first delivery', async () => {
    const inboxCreate = vi.fn().mockResolvedValue({});
    const auditCreate = vi.fn().mockResolvedValue({});
    const prisma = {
      $transaction: vi.fn(async (cb: (tx: unknown) => Promise<void>) =>
        cb({
          inboxEvent: { create: inboxCreate },
          auditLog: { create: auditCreate },
        }),
      ),
    } as unknown as PrismaService;

    const service = new AuditIngestionService(prisma);
    const event = createSampleEvent();

    const outcome = await service.ingest(event);

    expect(outcome).toBe('PROCESSED');
    expect(inboxCreate).toHaveBeenCalledOnce();
    expect(inboxCreate.mock.calls[0][0].data).toMatchObject({
      tenantId: event.tenantId,
      eventId: event.eventId,
      consumerName: AUDIT_CONSUMER_NAME,
      eventType: 'OrderConfirmed',
      outcome: 'PROCESSED',
    });
    expect(auditCreate).toHaveBeenCalledOnce();
    expect(auditCreate.mock.calls[0][0].data).toMatchObject({
      tenantId: event.tenantId,
      actorId: event.actorId,
      actorType: 'USER',
      action: 'ORDER_CONFIRMED',
      sourceService: ServiceId.ORDER_SERVICE,
      sourceEventId: event.eventId,
      correlationId: event.correlationId,
    });
    expect(auditCreate.mock.calls[0][0].data.afterData.secretToken).toBe(
      '[REDACTED]',
    );
  });

  it('ignores duplicate eventId idempotently when Prisma throws P2002', async () => {
    const seen = new Set<string>();
    const auditCreate = vi.fn().mockResolvedValue({});
    const prisma = {
      $transaction: vi.fn(async (cb: (tx: unknown) => Promise<void>) =>
        cb({
          inboxEvent: {
            create: vi.fn(async ({ data }: { data: { eventId: string } }) => {
              if (seen.has(data.eventId)) {
                const dupError = Object.assign(new Error('Unique constraint failed'), {
                  code: 'P2002',
                });
                throw dupError;
              }
              seen.add(data.eventId);
              return {};
            }),
          },
          auditLog: { create: auditCreate },
        }),
      ),
    } as unknown as PrismaService;

    const service = new AuditIngestionService(prisma);
    const event = createSampleEvent();

    expect(await service.ingest(event)).toBe('PROCESSED');
    expect(await service.ingest(event)).toBe('DUPLICATE');
    expect(auditCreate).toHaveBeenCalledTimes(1);
  });

  it('rethrows transient database errors so Kafka consumer does not advance offset', async () => {
    const prisma = {
      $transaction: vi.fn().mockRejectedValue(new Error('Connection terminated')),
    } as unknown as PrismaService;

    const service = new AuditIngestionService(prisma);
    await expect(service.ingest(createSampleEvent())).rejects.toThrow(
      'Connection terminated',
    );
  });
});
