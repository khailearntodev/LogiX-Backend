import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service.js';
import { Prisma } from '../../../generated/prisma/client.js';
import {
  DEFAULT_PAGE_SIZE,
  RecordStatus,
} from '../../common/master-data.constants.js';
import { toVehicleView } from '../../common/master-data.mappers.js';
import { isUniqueViolation, toConflict } from '../../common/prisma-error.js';
import type {
  Paginated,
  VehicleView,
} from '../../common/master-data.types.js';
import type { PaginationQueryDto } from '../../common/dto/pagination-query.dto.js';
import type {
  CreateVehicleDto,
  UpdateVehicleDto,
} from '../dto/vehicle.dto.js';

const DUPLICATE =
  'Mã phương tiện hoặc biển số đã tồn tại trong tổ chức này';

@Injectable()
export class VehicleService {
  constructor(private readonly prisma: PrismaService) {}

  async create(tenantId: string, dto: CreateVehicleDto): Promise<VehicleView> {
    try {
      const row = await this.prisma.vehicle.create({
        data: {
          tenantId,
          code: dto.code,
          licensePlate: dto.licensePlate,
          capacityWeight: new Prisma.Decimal(dto.capacityWeight),
          capacityVolume: new Prisma.Decimal(dto.capacityVolume),
          status: RecordStatus.ACTIVE,
        },
      });

      return toVehicleView(row);
    } catch (error) {
      toConflict(error, DUPLICATE);
    }
  }

  async list(
    tenantId: string,
    query: PaginationQueryDto,
  ): Promise<Paginated<VehicleView>> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

    const where: Prisma.VehicleWhereInput = {
      tenantId,
      deletedAt: null,
      ...(query.status ? { status: query.status } : {}),
      ...(query.q
        ? {
            OR: [
              { code: { contains: query.q, mode: 'insensitive' } },
              { licensePlate: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.vehicle.findMany({
        where,
        orderBy: [{ code: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.vehicle.count({ where }),
    ]);

    return { items: rows.map(toVehicleView), page, pageSize, total };
  }

  async getById(tenantId: string, id: string): Promise<VehicleView> {
    return toVehicleView(await this.requireVehicle(tenantId, id));
  }

  async update(
    tenantId: string,
    id: string,
    dto: UpdateVehicleDto,
  ): Promise<VehicleView> {
    await this.requireVehicle(tenantId, id);

    try {
      const row = await this.prisma.vehicle.update({
        where: { id },
        data: {
          ...(dto.licensePlate === undefined
            ? {}
            : { licensePlate: dto.licensePlate }),
          ...(dto.capacityWeight === undefined
            ? {}
            : { capacityWeight: new Prisma.Decimal(dto.capacityWeight) }),
          ...(dto.capacityVolume === undefined
            ? {}
            : { capacityVolume: new Prisma.Decimal(dto.capacityVolume) }),
          version: { increment: 1 },
        },
      });

      return toVehicleView(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        toConflict(error, DUPLICATE);
      }
      throw error;
    }
  }

  /** BR-TEN-004: referenced master data is disabled, never hard deleted. */
  async setStatus(
    tenantId: string,
    id: string,
    status: RecordStatus,
  ): Promise<VehicleView> {
    const current = await this.requireVehicle(tenantId, id);

    if (current.status === status) {
      return toVehicleView(current);
    }

    const row = await this.prisma.vehicle.update({
      where: { id },
      data: { status, version: { increment: 1 } },
    });

    return toVehicleView(row);
  }

  private async requireVehicle(tenantId: string, id: string) {
    const row = await this.prisma.vehicle.findFirst({
      where: { id, tenantId, deletedAt: null },
    });

    if (!row) {
      throw new NotFoundException('Không tìm thấy phương tiện');
    }

    return row;
  }
}
