import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service.js';
import { Prisma } from '../../../generated/prisma/client.js';
import {
  DEFAULT_PAGE_SIZE,
  RecordStatus,
} from '../../common/master-data.constants.js';
import { toProductView } from '../../common/master-data.mappers.js';
import { toConflict } from '../../common/prisma-error.js';
import type {
  Paginated,
  ProductView,
} from '../../common/master-data.types.js';
import type { PaginationQueryDto } from '../../common/dto/pagination-query.dto.js';
import type {
  CreateProductDto,
  UpdateProductDto,
} from '../dto/product.dto.js';

const DUPLICATE_SKU = 'SKU đã tồn tại trong tổ chức này';

@Injectable()
export class ProductService {
  constructor(private readonly prisma: PrismaService) {}

  async create(tenantId: string, dto: CreateProductDto): Promise<ProductView> {
    try {
      const row = await this.prisma.product.create({
        data: {
          tenantId,
          sku: dto.sku,
          name: dto.name,
          baseUnit: dto.baseUnit,
          weight: new Prisma.Decimal(dto.weight),
          volume: new Prisma.Decimal(dto.volume),
          status: RecordStatus.ACTIVE,
        },
      });

      return toProductView(row);
    } catch (error) {
      toConflict(error, DUPLICATE_SKU);
    }
  }

  async list(
    tenantId: string,
    query: PaginationQueryDto,
  ): Promise<Paginated<ProductView>> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

    const where: Prisma.ProductWhereInput = {
      tenantId,
      deletedAt: null,
      ...(query.status ? { status: query.status } : {}),
      ...(query.q
        ? {
            OR: [
              { sku: { contains: query.q, mode: 'insensitive' } },
              { name: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.product.findMany({
        where,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.product.count({ where }),
    ]);

    return { items: rows.map(toProductView), page, pageSize, total };
  }

  async getById(tenantId: string, id: string): Promise<ProductView> {
    return toProductView(await this.requireProduct(tenantId, id));
  }

  async update(
    tenantId: string,
    id: string,
    dto: UpdateProductDto,
  ): Promise<ProductView> {
    await this.requireProduct(tenantId, id);

    const row = await this.prisma.product.update({
      where: { id },
      data: {
        ...(dto.name === undefined ? {} : { name: dto.name }),
        ...(dto.baseUnit === undefined ? {} : { baseUnit: dto.baseUnit }),
        ...(dto.weight === undefined
          ? {}
          : { weight: new Prisma.Decimal(dto.weight) }),
        ...(dto.volume === undefined
          ? {}
          : { volume: new Prisma.Decimal(dto.volume) }),
        version: { increment: 1 },
      },
    });

    return toProductView(row);
  }

  /** BR-TEN-004: referenced master data is disabled, never hard deleted. */
  async setStatus(
    tenantId: string,
    id: string,
    status: RecordStatus,
  ): Promise<ProductView> {
    const current = await this.requireProduct(tenantId, id);

    if (current.status === status) {
      return toProductView(current);
    }

    const row = await this.prisma.product.update({
      where: { id },
      data: { status, version: { increment: 1 } },
    });

    return toProductView(row);
  }

  private async requireProduct(tenantId: string, id: string) {
    const row = await this.prisma.product.findFirst({
      where: { id, tenantId, deletedAt: null },
    });

    if (!row) {
      throw new NotFoundException('Không tìm thấy sản phẩm');
    }

    return row;
  }
}
