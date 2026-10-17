import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { ORDER_DEFAULT_PAGE_SIZE } from '../domain/order-constants.js';
import { OrderErrors } from '../domain/order-errors.js';
import type { ListOrdersQueryDto } from '../dto/list-orders.query.js';
import {
  toOrderDetailView,
  toOrderHistoryView,
  toOrderSummaryView,
} from '../mappers/order.mapper.js';
import type {
  OrderDetailView,
  OrderHistoryView,
  OrderSummaryView,
  Paginated,
} from '../order.types.js';

const FIRST_PAGE = 1;

@Injectable()
export class OrderQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    tenantId: string,
    query: ListOrdersQueryDto,
  ): Promise<Paginated<OrderSummaryView>> {
    const createdFrom = query.createdFrom
      ? new Date(query.createdFrom)
      : undefined;
    const createdTo = query.createdTo ? new Date(query.createdTo) : undefined;
    if (createdFrom && createdTo && createdFrom > createdTo) {
      throw OrderErrors.invalidDateRange();
    }

    const page = query.page ?? FIRST_PAGE;
    const pageSize = query.pageSize ?? ORDER_DEFAULT_PAGE_SIZE;
    const where: Prisma.SalesOrderWhereInput = {
      tenantId,
      deletedAt: null,
      ...(query.q && {
        orderNumber: { contains: query.q, mode: 'insensitive' },
      }),
      ...(query.customerId && { customerId: query.customerId }),
      ...(query.warehouseId && { warehouseId: query.warehouseId }),
      ...(query.status?.length && { status: { in: query.status } }),
      ...((createdFrom || createdTo) && {
        createdAt: {
          ...(createdFrom && { gte: createdFrom }),
          ...(createdTo && { lte: createdTo }),
        },
      }),
    };

    const [orders, total] = await this.prisma.$transaction([
      this.prisma.salesOrder.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.salesOrder.count({ where }),
    ]);

    return { items: orders.map(toOrderSummaryView), page, pageSize, total };
  }

  async detail(tenantId: string, orderId: string): Promise<OrderDetailView> {
    const order = await this.prisma.salesOrder.findFirst({
      where: { id: orderId, tenantId, deletedAt: null },
      include: { lines: true },
    });
    if (!order) {
      throw OrderErrors.notFound(orderId);
    }
    return toOrderDetailView(order);
  }

  async history(
    tenantId: string,
    orderId: string,
  ): Promise<OrderHistoryView[]> {
    const order = await this.prisma.salesOrder.findFirst({
      where: { id: orderId, tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!order) {
      throw OrderErrors.notFound(orderId);
    }
    const entries = await this.prisma.orderStatusHistory.findMany({
      where: { tenantId, orderId, deletedAt: null },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    });
    return entries.map(toOrderHistoryView);
  }
}
