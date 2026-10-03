import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import { QueryBalancesDto } from '../dto/query-balances.dto.js';
import { QueryMovementsDto } from '../dto/query-movements.dto.js';
import { UpdateLowStockThresholdDto } from '../dto/update-low-stock-threshold.dto.js';
import { DEFAULT_PAGE_SIZE } from '../inventory.constants.js';
import { toBalanceView, toMovementView } from '../inventory.mappers.js';
import type {
  InventoryBalanceView,
  Paginated,
  StockMovementView,
} from '../inventory.types.js';

/**
 * Read side of inventory. `availableQuantity` is computed in the mapper because
 * the generated column is `@ignore`d in the Prisma model.
 */
@Injectable()
export class InventoryBalanceService {
  constructor(private readonly prisma: PrismaService) {}

  async listBalances(
    tenantId: string,
    query: QueryBalancesDto,
  ): Promise<Paginated<InventoryBalanceView>> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const skip = (page - 1) * pageSize;

    if (query.lowStockOnly) {
      return this.listLowStockBalances(tenantId, query, page, pageSize, skip);
    }

    const where: Prisma.InventoryBalanceWhereInput = {
      tenantId,
      deletedAt: null,
      ...(query.warehouseId ? { warehouseId: query.warehouseId } : {}),
      ...(query.productId ? { productId: query.productId } : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.inventoryBalance.findMany({
        where,
        orderBy: [{ warehouseId: 'asc' }, { productId: 'asc' }],
        skip,
        take: pageSize,
      }),
      this.prisma.inventoryBalance.count({ where }),
    ]);

    return {
      items: rows.map((row) => toBalanceView(row)),
      page,
      pageSize,
      total,
    };
  }

  async getBalance(
    tenantId: string,
    warehouseId: string,
    productId: string,
  ): Promise<InventoryBalanceView> {
    const row = await this.prisma.inventoryBalance.findFirst({
      where: { tenantId, warehouseId, productId, deletedAt: null },
    });

    if (!row) {
      throw new NotFoundException('Không tìm thấy tồn kho cho kho và sản phẩm này');
    }

    return toBalanceView(row);
  }

  async listMovements(
    tenantId: string,
    query: QueryMovementsDto,
  ): Promise<Paginated<StockMovementView>> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const skip = (page - 1) * pageSize;

    const where: Prisma.StockMovementWhereInput = {
      tenantId,
      deletedAt: null,
      ...(query.warehouseId ? { warehouseId: query.warehouseId } : {}),
      ...(query.productId ? { productId: query.productId } : {}),
      ...(query.referenceType ? { referenceType: query.referenceType } : {}),
      ...(query.referenceId ? { referenceId: query.referenceId } : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.stockMovement.findMany({
        where,
        // `id` breaks ties so paging stays stable when timestamps collide.
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        skip,
        take: pageSize,
      }),
      this.prisma.stockMovement.count({ where }),
    ]);

    return {
      items: rows.map((row) => toMovementView(row)),
      page,
      pageSize,
      total,
    };
  }

  async updateLowStockThreshold(
    tenantId: string,
    warehouseId: string,
    productId: string,
    dto: UpdateLowStockThresholdDto,
  ): Promise<InventoryBalanceView> {
    const existing = await this.prisma.inventoryBalance.findFirst({
      where: { tenantId, warehouseId, productId, deletedAt: null },
      select: { id: true },
    });

    if (!existing) {
      throw new NotFoundException('Không tìm thấy tồn kho cho kho và sản phẩm này');
    }

    const updated = await this.prisma.inventoryBalance.update({
      where: { id: existing.id },
      data: { lowStockThreshold: new Prisma.Decimal(dto.lowStockThreshold) },
    });

    return toBalanceView(updated);
  }

  /**
   * `available <= threshold` compares two columns, which Prisma `where` cannot
   * express, so matching ids come from SQL while the rows stay typed.
   */
  private async listLowStockBalances(
    tenantId: string,
    query: QueryBalancesDto,
    page: number,
    pageSize: number,
    skip: number,
  ): Promise<Paginated<InventoryBalanceView>> {
    const conditions: Prisma.Sql[] = [
      Prisma.sql`tenant_id = ${tenantId}::uuid`,
      Prisma.sql`deleted_at IS NULL`,
      Prisma.sql`(on_hand_quantity - reserved_quantity) <= low_stock_threshold`,
    ];

    if (query.warehouseId) {
      conditions.push(Prisma.sql`warehouse_id = ${query.warehouseId}::uuid`);
    }
    if (query.productId) {
      conditions.push(Prisma.sql`product_id = ${query.productId}::uuid`);
    }

    const whereSql = Prisma.join(conditions, ' AND ');

    const idRows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id
      FROM inventory.inventory_balances
      WHERE ${whereSql}
      ORDER BY warehouse_id ASC, product_id ASC
      LIMIT ${pageSize} OFFSET ${skip}
    `);

    const totalRows = await this.prisma.$queryRaw<Array<{ total: number }>>(Prisma.sql`
      SELECT COUNT(*)::int AS total
      FROM inventory.inventory_balances
      WHERE ${whereSql}
    `);

    const total = totalRows[0]?.total ?? 0;

    if (idRows.length === 0) {
      return { items: [], page, pageSize, total };
    }

    const rows = await this.prisma.inventoryBalance.findMany({
      where: { id: { in: idRows.map((row) => row.id) } },
      orderBy: [{ warehouseId: 'asc' }, { productId: 'asc' }],
    });

    return {
      items: rows.map((row) => toBalanceView(row)),
      page,
      pageSize,
      total,
    };
  }
}
