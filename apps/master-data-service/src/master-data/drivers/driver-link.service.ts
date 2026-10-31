import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ConcurrencyConflictError, DomainError } from '@logix/errors';
import { PrismaService } from '../../database/prisma.service.js';
import type { Driver } from '../../generated/prisma/client.js';
import { IdentityDriverClient } from './identity-driver.client.js';
import { TransportDriverClient } from './transport-driver.client.js';
import {
  DriverLinkLockedError,
  DriverLinkUnchangedError,
} from './driver-link.errors.js';
import type {
  DriverLinkLockDto,
  RelinkDriverUserDto,
} from './dto/driver.dto.js';
import { driverView } from './driver.service.js';
import { isUniqueViolation } from '../common/prisma-error.js';

export const DRIVER_USER_RELINKED_EVENT = 'DriverUserRelinked';
export const DRIVER_USER_RELINK_ACTION = 'driver.relink-user';

@Injectable()
export class DriverLinkService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly identity: IdentityDriverClient,
    private readonly transport: TransportDriverClient,
  ) {}

  private assertBinding(
    row: Pick<Driver, 'id' | 'userId' | 'version'>,
    dto: DriverLinkLockDto,
  ) {
    if (
      row.version !== BigInt(dto.version) ||
      row.userId !== dto.expectedUserId
    )
      throw new ConcurrencyConflictError(
        'Driver',
        row.id,
        dto.version,
        Number(row.version),
      );
  }

  private async prepare(
    tenantId: string,
    id: string,
    dto: RelinkDriverUserDto,
  ) {
    const row = await this.prisma.driver.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!row) throw new NotFoundException('Không tìm thấy tài xế');
    this.assertBinding(row, dto);
    if (row.linkLockedAt) throw new DriverLinkLockedError(id);
    if (row.userId === dto.userId) throw new DriverLinkUnchangedError(id);
    if (row.version >= BigInt(Number.MAX_SAFE_INTEGER))
      throw new ConcurrencyConflictError(
        'Driver',
        id,
        dto.version,
        Number(row.version),
      );
    const [user, previousUsers, used, duplicate] = await Promise.all([
      this.identity.eligible(tenantId, dto.userId),
      this.identity.resolve(tenantId, [row.userId]),
      this.transport.used(tenantId, id),
      this.prisma.driver.findFirst({ where: { tenantId, userId: dto.userId } }),
    ]);
    if (used) throw new DriverLinkLockedError(id);
    if (duplicate)
      throw new ConflictException(
        'Người dùng đã liên kết với tài xế khác trong tổ chức',
      );
    const previousUser = previousUsers[0];
    if (!previousUser)
      throw new InternalServerErrorException(
        'Không thể đối chiếu người dùng tài xế',
      );
    return { row, user, previousUser };
  }

  async preview(tenantId: string, id: string, dto: RelinkDriverUserDto) {
    const { row, user, previousUser } = await this.prepare(tenantId, id, dto);
    return {
      driverId: id,
      version: Number(row.version),
      previousUserId: row.userId,
      userId: user.id,
      previousDisplayName: previousUser.displayName,
      displayName: user.displayName,
      reason: dto.reason,
    };
  }

  async relink(
    tenantId: string,
    id: string,
    actorId: string,
    dto: RelinkDriverUserDto,
    requestCorrelationId?: string,
  ) {
    // No network calls inside the transaction. Every future trip writer must
    // acquire lockBinding before persisting a reference (including a draft).
    const { user } = await this.prepare(tenantId, id, dto);
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const changed = await tx.driver.updateMany({
          where: {
            id,
            tenantId,
            deletedAt: null,
            userId: dto.expectedUserId,
            version: BigInt(dto.version),
            linkLockedAt: null,
          },
          data: { userId: dto.userId, version: { increment: 1 } },
        });
        const current = await tx.driver.findFirst({
          where: { id, tenantId, deletedAt: null },
        });
        if (!current) throw new NotFoundException('Không tìm thấy tài xế');
        if (changed.count !== 1) {
          if (current.linkLockedAt) throw new DriverLinkLockedError(id);
          throw new ConcurrencyConflictError(
            'Driver',
            id,
            dto.version,
            Number(current.version),
          );
        }
        const occurredAt = new Date();
        const eventId = randomUUID(),
          correlationId = requestCorrelationId ?? randomUUID();
        await tx.outboxEvent.create({
          data: {
            id: eventId,
            tenantId,
            eventType: DRIVER_USER_RELINKED_EVENT,
            eventVersion: 1,
            aggregateType: 'Driver',
            aggregateId: id,
            aggregateVersion: current.version,
            correlationId,
            occurredAt,
            payload: {
              tenantId,
              actorId,
              actorType: 'USER',
              action: DRIVER_USER_RELINK_ACTION,
              entityType: 'Driver',
              entityId: id,
              outcome: 'SUCCESS',
              beforeData: { userId: dto.expectedUserId, version: dto.version },
              afterData: {
                userId: dto.userId,
                version: Number(current.version),
              },
              metadata: { reason: dto.reason },
              correlationId,
              causationId: null,
              sourceService: 'master-data-service',
              sourceEventId: eventId,
              occurredAt: occurredAt.toISOString(),
            },
          },
        });
        return current;
      });
      return driverView(row, user);
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ConflictException(
          'Người dùng đã liên kết với tài xế khác trong tổ chức',
        );
      if (error instanceof DomainError || error instanceof HttpException)
        throw error;
      // Database diagnostics can contain the audit reason/payload; never log it.
      throw new InternalServerErrorException(
        'Không thể lưu liên kết và bằng chứng kiểm toán',
      );
    }
  }

  async lockBinding(tenantId: string, id: string, dto: DriverLinkLockDto) {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        Pick<
          Driver,
          'id' | 'tenantId' | 'userId' | 'version' | 'linkLockedAt'
        >[]
      >`
        SELECT id, tenant_id AS "tenantId", user_id AS "userId",
               version, link_locked_at AS "linkLockedAt"
        FROM master_data.drivers
        WHERE id = ${id}::uuid AND tenant_id = ${tenantId}::uuid AND deleted_at IS NULL
        FOR UPDATE`;
      const row = rows[0];
      if (!row) throw new NotFoundException('Không tìm thấy tài xế');
      this.assertBinding(row, dto);
      if (!row.linkLockedAt)
        await tx.driver.update({
          where: { id },
          data: { linkLockedAt: new Date() },
        });
      return { driverId: id, userId: row.userId, version: Number(row.version) };
    });
  }
}
