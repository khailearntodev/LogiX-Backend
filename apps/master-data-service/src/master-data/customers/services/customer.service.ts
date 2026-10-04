import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service.js';
import { Prisma } from '../../../generated/prisma/client.js';
import {
  DEFAULT_PAGE_SIZE,
  RecordStatus,
} from '../../common/master-data.constants.js';
import { toCustomerView } from '../../common/master-data.mappers.js';
import { toConflict } from '../../common/prisma-error.js';
import type {
  CustomerView,
  Paginated,
} from '../../common/master-data.types.js';
import type { PaginationQueryDto } from '../../common/dto/pagination-query.dto.js';
import type {
  CreateCustomerDto,
  UpdateCustomerDto,
} from '../dto/customer.dto.js';

const DUPLICATE_CODE = 'Mã khách hàng đã tồn tại trong tổ chức này';

@Injectable()
export class CustomerService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    tenantId: string,
    dto: CreateCustomerDto,
  ): Promise<CustomerView> {
    try {
      const row = await this.prisma.customer.create({
        data: {
          tenantId,
          code: dto.code,
          name: dto.name,
          taxCode: dto.taxCode ?? null,
          phone: dto.phone ?? null,
          email: dto.email ?? null,
          status: RecordStatus.ACTIVE,
        },
      });

      return toCustomerView(row);
    } catch (error) {
      toConflict(error, DUPLICATE_CODE);
    }
  }

  async list(
    tenantId: string,
    query: PaginationQueryDto,
  ): Promise<Paginated<CustomerView>> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

    const where: Prisma.CustomerWhereInput = {
      tenantId,
      deletedAt: null,
      ...(query.status ? { status: query.status } : {}),
      ...(query.q
        ? {
            OR: [
              { code: { contains: query.q, mode: 'insensitive' } },
              { name: { contains: query.q, mode: 'insensitive' } },
              { phone: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.customer.findMany({
        where,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.customer.count({ where }),
    ]);

    return { items: rows.map(toCustomerView), page, pageSize, total };
  }

  async getById(tenantId: string, id: string): Promise<CustomerView> {
    return toCustomerView(await this.requireCustomer(tenantId, id));
  }

  async update(
    tenantId: string,
    id: string,
    dto: UpdateCustomerDto,
  ): Promise<CustomerView> {
    await this.requireCustomer(tenantId, id);

    const row = await this.prisma.customer.update({
      where: { id },
      data: {
        ...(dto.name === undefined ? {} : { name: dto.name }),
        ...(dto.taxCode === undefined ? {} : { taxCode: dto.taxCode }),
        ...(dto.phone === undefined ? {} : { phone: dto.phone }),
        ...(dto.email === undefined ? {} : { email: dto.email }),
        version: { increment: 1 },
      },
    });

    return toCustomerView(row);
  }

  /**
   * BR-TEN-004: disable only. Customer is the one model carrying
   * `disabledAt` / `disabledReason`, so the reason is persisted here.
   */
  async disable(
    tenantId: string,
    id: string,
    reason?: string,
  ): Promise<CustomerView> {
    const current = await this.requireCustomer(tenantId, id);

    if (current.status === RecordStatus.INACTIVE) {
      return toCustomerView(current);
    }

    const row = await this.prisma.customer.update({
      where: { id },
      data: {
        status: RecordStatus.INACTIVE,
        disabledAt: new Date(),
        disabledReason: reason ?? null,
        version: { increment: 1 },
      },
    });

    return toCustomerView(row);
  }

  async enable(tenantId: string, id: string): Promise<CustomerView> {
    const current = await this.requireCustomer(tenantId, id);

    if (current.status === RecordStatus.ACTIVE) {
      return toCustomerView(current);
    }

    const row = await this.prisma.customer.update({
      where: { id },
      data: {
        status: RecordStatus.ACTIVE,
        disabledAt: null,
        disabledReason: null,
        version: { increment: 1 },
      },
    });

    return toCustomerView(row);
  }

  private async requireCustomer(tenantId: string, id: string) {
    const row = await this.prisma.customer.findFirst({
      where: { id, tenantId, deletedAt: null },
    });

    if (!row) {
      throw new NotFoundException('Không tìm thấy khách hàng');
    }

    return row;
  }
}
