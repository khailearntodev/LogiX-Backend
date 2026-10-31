import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ConcurrencyConflictError } from '@logix/errors';
import { PrismaService } from '../../database/prisma.service.js';
import { Prisma, type Driver } from '../../generated/prisma/client.js';
import {
  DEFAULT_PAGE_SIZE,
  RecordStatus,
} from '../common/master-data.constants.js';
import {
  allocateNextMasterDataCode,
  syncMasterDataCodeSequence,
} from '../common/master-data-code.js';
import { isUniqueViolation } from '../common/prisma-error.js';
import type { PaginationQueryDto } from '../common/dto/pagination-query.dto.js';
import type { CreateDriverDto, UpdateDriverDto } from './dto/driver.dto.js';
import {
  IdentityDriverClient,
  type DriverUser,
} from './identity-driver.client.js';

export function driverView(row: Driver, user: DriverUser) {
  const version = Number(row.version);
  if (!Number.isSafeInteger(version))
    throw new InternalServerErrorException(
      'Phiên bản tài xế vượt giới hạn hỗ trợ',
    );
  return {
    id: row.id,
    tenantId: row.tenantId,
    code: row.code,
    userId: row.userId,
    displayName: user.displayName,
    licenseNumber: row.licenseNumber,
    licenseExpiry: row.licenseExpiry.toISOString().slice(0, 10),
    phone: row.phone,
    status: row.status,
    version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

@Injectable()
export class DriverService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly identity: IdentityDriverClient,
  ) {}

  async create(tenantId: string, dto: CreateDriverDto) {
    const user = await this.identity.eligible(tenantId, dto.userId);
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const manualCode = dto.code?.trim();
        const existingCodes = (
          await tx.driver.findMany({
            where: { tenantId },
            select: { code: true },
          })
        ).map((driver) => driver.code);
        await syncMasterDataCodeSequence(
          tx,
          tenantId,
          'driver',
          existingCodes,
          manualCode,
        );
        const code =
          manualCode ??
          (await allocateNextMasterDataCode(tx, tenantId, 'driver'));

        return tx.driver.create({
          data: {
            tenantId,
            ...dto,
            code,
            licenseExpiry: new Date(dto.licenseExpiry),
            status: RecordStatus.ACTIVE,
          },
        });
      });
      return driverView(row, user);
    } catch (error) {
      this.writeError(error);
    }
  }

  async list(tenantId: string, query: PaginationQueryDto) {
    const page = query.page ?? 1,
      pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const where: Prisma.DriverWhereInput = {
      tenantId,
      deletedAt: null,
      ...(query.status ? { status: query.status } : {}),
      ...(query.q
        ? {
            OR: [
              { code: { contains: query.q, mode: 'insensitive' } },
              { licenseNumber: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.driver.findMany({
        where,
        orderBy: [{ code: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.driver.count({ where }),
    ]);
    const users = await this.identity.resolve(tenantId, [
      ...new Set(rows.map((row) => row.userId)),
    ]);
    return {
      items: rows.map((row) => {
        const user = users.find((user) => user.id === row.userId);
        if (!user)
          throw new InternalServerErrorException(
            'Không thể đối chiếu người dùng tài xế',
          );
        return driverView(row, user);
      }),
      total,
      page,
      pageSize,
    };
  }

  async getById(tenantId: string, id: string) {
    const row = await this.require(tenantId, id);
    const [user] = await this.identity.resolve(tenantId, [row.userId]);
    if (!user)
      throw new InternalServerErrorException(
        'Không thể đối chiếu người dùng tài xế',
      );
    return driverView(row, user);
  }

  async eligibleForTrip(tenantId: string, id: string) {
    const row = await this.require(tenantId, id);
    if (row.status !== RecordStatus.ACTIVE)
      throw new ConflictException('DRIVER_MUST_BE_ACTIVE');
    return driverView(row, await this.identity.eligible(tenantId, row.userId));
  }

  async update(tenantId: string, id: string, dto: UpdateDriverDto) {
    const current = await this.require(tenantId, id);
    const [user] = await this.identity.resolve(tenantId, [current.userId]);
    if (!user)
      throw new InternalServerErrorException(
        'Không thể đối chiếu người dùng tài xế',
      );
    try {
      const code = dto.code?.trim();
      const row = await this.prisma.$transaction(async (tx) => {
        if (code) {
          await syncMasterDataCodeSequence(tx, tenantId, 'driver', [], code);
        }

        const result = await tx.driver.updateMany({
          where: {
            id,
            tenantId,
            deletedAt: null,
            version: {
              equals: BigInt(dto.version),
              lt: BigInt(Number.MAX_SAFE_INTEGER),
            },
          },
          data: {
            ...(code ? { code } : {}),
            ...(dto.licenseNumber !== undefined
              ? { licenseNumber: dto.licenseNumber }
              : {}),
            ...(dto.licenseExpiry !== undefined
              ? { licenseExpiry: new Date(dto.licenseExpiry) }
              : {}),
            ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
            version: { increment: 1 },
          },
        });
        await this.assertUpdated(tx, result.count, tenantId, id, dto.version);
        return tx.driver.findFirstOrThrow({ where: { id, tenantId } });
      });
      return driverView(row, user);
    } catch (error) {
      this.writeError(error);
    }
  }

  async setStatus(
    tenantId: string,
    id: string,
    version: number,
    status: RecordStatus,
  ) {
    const current = await this.require(tenantId, id);
    const users =
      status === RecordStatus.ACTIVE
        ? [await this.identity.eligible(tenantId, current.userId)]
        : await this.identity.resolve(tenantId, [current.userId]);
    const user = users[0];
    if (!user)
      throw new InternalServerErrorException(
        'Không thể đối chiếu người dùng tài xế',
      );
    const row = await this.prisma.$transaction(async (tx) => {
      const result = await tx.driver.updateMany({
        where: {
          id,
          tenantId,
          deletedAt: null,
          version: {
            equals: BigInt(version),
            lt: BigInt(Number.MAX_SAFE_INTEGER),
          },
        },
        data: { status, version: { increment: 1 } },
      });
      await this.assertUpdated(tx, result.count, tenantId, id, version);
      return tx.driver.findFirstOrThrow({ where: { id, tenantId } });
    });
    return driverView(row, user);
  }

  private async require(tenantId: string, id: string) {
    const row = await this.prisma.driver.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!row) throw new NotFoundException('Không tìm thấy tài xế');
    return row;
  }

  private async assertUpdated(
    tx: Prisma.TransactionClient,
    count: number,
    tenantId: string,
    id: string,
    expectedVersion: number,
  ) {
    if (count === 1) return;
    const row = await tx.driver.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!row) throw new NotFoundException('Không tìm thấy tài xế');
    throw new ConcurrencyConflictError(
      'Driver',
      id,
      expectedVersion,
      Number(row.version),
    );
  }

  private writeError(error: unknown): never {
    if (isUniqueViolation(error))
      throw new ConflictException(
        'Mã tài xế, người dùng hoặc GPLX đã tồn tại trong tổ chức',
      );
    throw error;
  }
}
