import { Injectable, NotImplementedException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { QueryBalancesDto } from '../dto/query-balances.dto.js';
import { QueryMovementsDto } from '../dto/query-movements.dto.js';
import { UpdateLowStockThresholdDto } from '../dto/update-low-stock-threshold.dto.js';
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
    _tenantId: string,
    _query: QueryBalancesDto,
  ): Promise<Paginated<InventoryBalanceView>> {
    throw new NotImplementedException('listBalances chưa được triển khai');
  }

  async getBalance(
    _tenantId: string,
    _warehouseId: string,
    _productId: string,
  ): Promise<InventoryBalanceView> {
    throw new NotImplementedException('getBalance chưa được triển khai');
  }

  async listMovements(
    _tenantId: string,
    _query: QueryMovementsDto,
  ): Promise<Paginated<StockMovementView>> {
    throw new NotImplementedException('listMovements chưa được triển khai');
  }

  async updateLowStockThreshold(
    _tenantId: string,
    _warehouseId: string,
    _productId: string,
    _dto: UpdateLowStockThresholdDto,
  ): Promise<InventoryBalanceView> {
    throw new NotImplementedException('updateLowStockThreshold chưa được triển khai');
  }
}
