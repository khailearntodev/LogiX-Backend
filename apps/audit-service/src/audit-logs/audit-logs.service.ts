import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../database/prisma.service.js';
import {
  AUDIT_DEFAULT_LIMIT,
  AUDIT_DEFAULT_PAGE,
  AUDIT_MAX_LIMIT,
} from './audit-logs.constants.js';
import type { QueryAuditLogsDto } from './dto/query-audit-logs.dto.js';

export interface AuditLogResponse {
  id: string;
  tenantId: string;
  actorId: string | null;
  actorType: string;
  action: string;
  entityType: string;
  entityId: string | null;
  outcome: string;
  beforeData: unknown;
  afterData: unknown;
  metadata: unknown;
  correlationId: string;
  causationId: string | null;
  sourceService: string;
  sourceEventId: string | null;
  occurredAt: string;
  ingestedAt: string;
  latencyMs: number;
}

export interface AuditLogsPageResponse {
  items: AuditLogResponse[];
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface AuditCorrelationChainResponse {
  correlationId: string;
  total: number;
  items: AuditLogResponse[];
}

interface AuditLogRow {
  id: string;
  tenantId: string;
  actorId: string | null;
  actorType: string;
  action: string;
  entityType: string;
  entityId: string | null;
  outcome: string;
  beforeData: unknown;
  afterData: unknown;
  metadata: unknown;
  correlationId: string;
  causationId: string | null;
  sourceService: string;
  sourceEventId: string | null;
  occurredAt: Date;
  ingestedAt: Date;
}

function serializeAuditLog(row: AuditLogRow): AuditLogResponse {
  const latencyMs = Math.max(
    0,
    row.ingestedAt.getTime() - row.occurredAt.getTime(),
  );
  return {
    id: row.id,
    tenantId: row.tenantId,
    actorId: row.actorId,
    actorType: row.actorType,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    outcome: row.outcome,
    beforeData: row.beforeData ?? null,
    afterData: row.afterData ?? null,
    metadata: row.metadata,
    correlationId: row.correlationId,
    causationId: row.causationId,
    sourceService: row.sourceService,
    sourceEventId: row.sourceEventId,
    occurredAt: row.occurredAt.toISOString(),
    ingestedAt: row.ingestedAt.toISOString(),
    latencyMs,
  };
}

@Injectable()
export class AuditLogsService {
  constructor(private readonly prisma: PrismaService) {}

  async listAuditLogs(
    tenantId: string,
    query: QueryAuditLogsDto,
  ): Promise<AuditLogsPageResponse> {
    if (!isUUID(tenantId)) {
      throw new BadRequestException('Mã tổ chức không hợp lệ');
    }

    const fromDate = query.from ? new Date(query.from) : undefined;
    const toDate = query.to ? new Date(query.to) : undefined;

    if (fromDate && Number.isNaN(fromDate.getTime())) {
      throw new BadRequestException('Thời điểm bắt đầu (from) không hợp lệ');
    }
    if (toDate && Number.isNaN(toDate.getTime())) {
      throw new BadRequestException('Thời điểm kết thúc (to) không hợp lệ');
    }
    if (fromDate && toDate && fromDate.getTime() > toDate.getTime()) {
      throw new BadRequestException(
        'Thời điểm bắt đầu phải nhỏ hơn hoặc bằng thời điểm kết thúc',
      );
    }

    const page = Math.max(1, query.page ?? AUDIT_DEFAULT_PAGE);
    const limit = Math.min(
      AUDIT_MAX_LIMIT,
      Math.max(1, query.limit ?? AUDIT_DEFAULT_LIMIT),
    );
    const skip = (page - 1) * limit;

    const where: Prisma.AuditLogWhereInput = {
      tenantId,
      deletedAt: null,
      ...(query.actorId ? { actorId: query.actorId } : {}),
      ...(query.actorType ? { actorType: query.actorType } : {}),
      ...(query.action
        ? { action: { contains: query.action.trim(), mode: 'insensitive' } }
        : {}),
      ...(query.entityType
        ? {
            entityType: {
              equals: query.entityType.trim(),
              mode: 'insensitive',
            },
          }
        : {}),
      ...(query.entityId ? { entityId: query.entityId } : {}),
      ...(query.outcome ? { outcome: query.outcome } : {}),
      ...(query.sourceService
        ? { sourceService: query.sourceService.trim() }
        : {}),
      ...(query.correlationId ? { correlationId: query.correlationId } : {}),
      ...(fromDate || toDate
        ? {
            occurredAt: {
              ...(fromDate ? { gte: fromDate } : {}),
              ...(toDate ? { lte: toDate } : {}),
            },
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        skip,
        take: limit,
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return {
      items: rows.map(serializeAuditLog),
      meta: {
        page,
        limit,
        total,
        totalPages: total === 0 ? 0 : Math.ceil(total / limit),
      },
    };
  }

  async getAuditLogById(
    tenantId: string,
    id: string,
  ): Promise<AuditLogResponse> {
    if (!isUUID(tenantId)) {
      throw new BadRequestException('Mã tổ chức không hợp lệ');
    }
    if (!isUUID(id)) {
      throw new BadRequestException('Mã bản ghi nhật ký kiểm toán không hợp lệ');
    }

    const row = await this.prisma.auditLog.findFirst({
      where: {
        id,
        tenantId,
        deletedAt: null,
      },
    });

    if (!row) {
      throw new NotFoundException('Không tìm thấy bản ghi nhật ký kiểm toán');
    }

    return serializeAuditLog(row);
  }

  async getCorrelationChain(
    tenantId: string,
    correlationId: string,
  ): Promise<AuditCorrelationChainResponse> {
    if (!isUUID(tenantId)) {
      throw new BadRequestException('Mã tổ chức không hợp lệ');
    }
    if (!isUUID(correlationId)) {
      throw new BadRequestException('Mã truy vết (correlationId) không hợp lệ');
    }

    const rows = await this.prisma.auditLog.findMany({
      where: {
        tenantId,
        correlationId,
        deletedAt: null,
      },
      orderBy: [{ occurredAt: 'asc' }, { ingestedAt: 'asc' }],
    });

    const items = rows.map(serializeAuditLog);
    return {
      correlationId,
      total: items.length,
      items,
    };
  }
}
