import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { DEFAULT_PAGE_SIZE, ShipmentErrors } from './shipment.domain.js';
import type { ShipmentQueryDto } from './shipment.dto.js';
import { shipmentView } from './shipment.persistence.js';

@Injectable()
export class ShipmentQueryService {
  constructor(private readonly prisma: PrismaService) {}
  async list(tenantId: string, query: ShipmentQueryDto) {
    const page = query.page ?? 1,
      pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    if (
      query.createdFrom &&
      query.createdTo &&
      new Date(query.createdFrom) > new Date(query.createdTo)
    )
      throw new BadRequestException('Khoảng ngày không hợp lệ');
    const where = {
      tenantId,
      deletedAt: null,
      ...(query.warehouseId && { warehouseId: query.warehouseId }),
      ...(query.orderId && { orderId: query.orderId }),
      ...(query.status && { status: query.status }),
      ...((query.createdFrom || query.createdTo) && {
        createdAt: {
          ...(query.createdFrom && { gte: new Date(query.createdFrom) }),
          ...(query.createdTo && { lte: new Date(query.createdTo) }),
        },
      }),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.shipment.findMany({
        where,
        include: { dispatchIntent: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.shipment.count({ where }),
    ]);
    return shipmentView({ items, total, page, pageSize });
  }
  async detail(tenantId: string, id: string) {
    const row = await this.prisma.shipment.findFirst({
      where: { tenantId, id, deletedAt: null },
      include: {
        items: { where: { deletedAt: null }, orderBy: { id: 'asc' } },
        dispatchIntent: true,
        statusHistory: { orderBy: [{ shipmentVersion: 'asc' }] },
      },
    });
    if (!row) throw ShipmentErrors.missing();
    return shipmentView(row);
  }
}
