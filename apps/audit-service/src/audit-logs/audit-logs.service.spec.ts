import { randomUUID } from 'node:crypto';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../database/prisma.service.js';
import { AuditLogsService } from './audit-logs.service.js';

function makeAuditRow(overrides: Record<string, unknown> = {}) {
  const occurredAt = new Date('2026-11-24T10:00:00.000Z');
  const ingestedAt = new Date('2026-11-24T10:00:00.250Z');
  return {
    id: randomUUID(),
    tenantId: randomUUID(),
    actorId: randomUUID(),
    actorType: 'USER',
    action: 'ORDER_CONFIRMED',
    entityType: 'SalesOrder',
    entityId: randomUUID(),
    outcome: 'SUCCESS',
    beforeData: { status: 'DRAFT' },
    afterData: { status: 'CONFIRMED' },
    metadata: { eventType: 'OrderConfirmed', eventVersion: 1 },
    correlationId: randomUUID(),
    causationId: randomUUID(),
    sourceService: 'order-service',
    sourceEventId: randomUUID(),
    occurredAt,
    ingestedAt,
    version: 1n,
    ...overrides,
  };
}

describe('AuditLogsService', () => {
  it('filters strictly by tenantId, computes latencyMs, and paginates results', async () => {
    const tenantId = randomUUID();
    const row = makeAuditRow({ tenantId });
    const findMany = vi.fn().mockResolvedValue([row]);
    const count = vi.fn().mockResolvedValue(21);
    const prisma = {
      auditLog: { findMany, count },
    } as unknown as PrismaService;

    const service = new AuditLogsService(prisma);
    const result = await service.listAuditLogs(tenantId, {
      action: 'ORDER',
      outcome: 'SUCCESS',
      page: 2,
      limit: 10,
      from: '2026-11-24T00:00:00.000Z',
      to: '2026-11-24T23:59:59.000Z',
    });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId,
          deletedAt: null,
          outcome: 'SUCCESS',
          action: { contains: 'ORDER', mode: 'insensitive' },
        }),
        skip: 10,
        take: 10,
      }),
    );
    expect(result.meta).toEqual({
      page: 2,
      limit: 10,
      total: 21,
      totalPages: 3,
    });
    expect(result.items[0].latencyMs).toBe(250);
    expect(result.items[0]).not.toHaveProperty('version');
  });

  it('rejects invalid date range when from is after to', async () => {
    const prisma = { auditLog: { findMany: vi.fn(), count: vi.fn() } } as unknown as PrismaService;
    const service = new AuditLogsService(prisma);

    await expect(
      service.listAuditLogs(randomUUID(), {
        from: '2026-11-25T00:00:00.000Z',
        to: '2026-11-24T00:00:00.000Z',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('returns 404 when accessing an audit log belonging to another tenant', async () => {
    const tenantA = randomUUID();
    const recordId = randomUUID();
    const findFirst = vi.fn().mockResolvedValue(null);
    const prisma = { auditLog: { findFirst } } as unknown as PrismaService;

    const service = new AuditLogsService(prisma);
    await expect(service.getAuditLogById(tenantA, recordId)).rejects.toThrow(
      NotFoundException,
    );
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: recordId, tenantId: tenantA, deletedAt: null },
    });
  });

  it('returns correlation chain sorted ascending by occurredAt within tenant scope', async () => {
    const tenantId = randomUUID();
    const correlationId = randomUUID();
    const first = makeAuditRow({
      tenantId,
      correlationId,
      sourceService: 'order-service',
      occurredAt: new Date('2026-11-24T10:00:00.000Z'),
      ingestedAt: new Date('2026-11-24T10:00:00.100Z'),
    });
    const second = makeAuditRow({
      tenantId,
      correlationId,
      sourceService: 'inventory-service',
      occurredAt: new Date('2026-11-24T10:00:01.000Z'),
      ingestedAt: new Date('2026-11-24T10:00:01.150Z'),
    });
    const findMany = vi.fn().mockResolvedValue([first, second]);
    const prisma = { auditLog: { findMany } } as unknown as PrismaService;

    const service = new AuditLogsService(prisma);
    const chain = await service.getCorrelationChain(tenantId, correlationId);

    expect(findMany).toHaveBeenCalledWith({
      where: { tenantId, correlationId, deletedAt: null },
      orderBy: [{ occurredAt: 'asc' }, { ingestedAt: 'asc' }],
    });
    expect(chain.correlationId).toBe(correlationId);
    expect(chain.total).toBe(2);
    expect(chain.items.map((item) => item.sourceService)).toEqual([
      'order-service',
      'inventory-service',
    ]);
  });
});
