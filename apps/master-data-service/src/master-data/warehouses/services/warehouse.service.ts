import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service.js';
import { Prisma } from '../../../generated/prisma/client.js';
import {
  DEFAULT_PAGE_SIZE,
  RecordStatus,
} from '../../common/master-data.constants.js';
import { toWarehouseView } from '../../common/master-data.mappers.js';
import { toConflict } from '../../common/prisma-error.js';
import type {
  Paginated,
  WarehouseView,
} from '../../common/master-data.types.js';
import type { PaginationQueryDto } from '../../common/dto/pagination-query.dto.js';
import type { CreateWarehouseDto } from '../dto/create-warehouse.dto.js';
import type { UpdateWarehouseDto } from '../dto/update-warehouse.dto.js';

const DUPLICATE_CODE = 'Mã kho đã tồn tại trong tổ chức này';

@Injectable()
export class WarehouseService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    tenantId: string,
    dto: CreateWarehouseDto,
  ): Promise<WarehouseView> {
    try {
      const row = await this.prisma.warehouse.create({
        data: {
          tenantId,
          code: dto.code,
          name: dto.name,
          addressLine: dto.addressLine,
          ward: dto.ward ?? null,
          district: dto.district ?? null,
          province: dto.province,
          postalCode: dto.postalCode ?? null,
          latitude: dto.latitude ? new Prisma.Decimal(dto.latitude) : null,
          longitude: dto.longitude ? new Prisma.Decimal(dto.longitude) : null,
          status: RecordStatus.ACTIVE,
        },
      });

      return toWarehouseView(row);
    } catch (error) {
      toConflict(error, DUPLICATE_CODE);
    }
  }

  async list(
    tenantId: string,
    query: PaginationQueryDto,
  ): Promise<Paginated<WarehouseView>> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

    const where: Prisma.WarehouseWhereInput = {
      tenantId,
      deletedAt: null,
      ...(query.status ? { status: query.status } : {}),
      ...(query.q
        ? {
            OR: [
              { code: { contains: query.q, mode: 'insensitive' } },
              { name: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.warehouse.findMany({
        where,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.warehouse.count({ where }),
    ]);

    return { items: rows.map(toWarehouseView), page, pageSize, total };
  }

  async getById(tenantId: string, id: string): Promise<WarehouseView> {
    return toWarehouseView(await this.requireWarehouse(tenantId, id));
  }

  async update(
    tenantId: string,
    id: string,
    dto: UpdateWarehouseDto,
  ): Promise<WarehouseView> {
    await this.requireWarehouse(tenantId, id);

    const row = await this.prisma.warehouse.update({
      where: { id },
      data: {
        ...(dto.name === undefined ? {} : { name: dto.name }),
        ...(dto.addressLine === undefined
          ? {}
          : { addressLine: dto.addressLine }),
        ...(dto.ward === undefined ? {} : { ward: dto.ward }),
        ...(dto.district === undefined ? {} : { district: dto.district }),
        ...(dto.province === undefined ? {} : { province: dto.province }),
        ...(dto.postalCode === undefined ? {} : { postalCode: dto.postalCode }),
        ...(dto.latitude === undefined
          ? {}
          : { latitude: new Prisma.Decimal(dto.latitude) }),
        ...(dto.longitude === undefined
          ? {}
          : { longitude: new Prisma.Decimal(dto.longitude) }),
        version: { increment: 1 },
      },
    });

    return toWarehouseView(row);
  }

  /** BR-TEN-004: referenced master data is disabled, never hard deleted. */
  async setStatus(
    tenantId: string,
    id: string,
    status: RecordStatus,
  ): Promise<WarehouseView> {
    const current = await this.requireWarehouse(tenantId, id);

    if (current.status === status) {
      return toWarehouseView(current);
    }

    const row = await this.prisma.warehouse.update({
      where: { id },
      data: { status, version: { increment: 1 } },
    });

    return toWarehouseView(row);
  }

  private async requireWarehouse(tenantId: string, id: string) {
    const row = await this.prisma.warehouse.findFirst({
      where: { id, tenantId, deletedAt: null },
    });

    if (!row) {
      throw new NotFoundException('Không tìm thấy kho hàng');
    }

    return row;
  }
}
