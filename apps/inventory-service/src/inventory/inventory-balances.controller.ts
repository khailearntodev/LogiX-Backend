import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface.js';
import { InventoryBalanceService } from './services/inventory-balance.service.js';
import { StockReceiptService } from './services/stock-receipt.service.js';
import { QueryBalancesDto } from './dto/query-balances.dto.js';
import { AdjustStockDto } from './dto/adjust-stock.dto.js';
import { UpdateLowStockThresholdDto } from './dto/update-low-stock-threshold.dto.js';

@Controller('inventory/balances')
@UseGuards(JwtAuthGuard)
export class InventoryBalancesController {
  constructor(
    private readonly balanceService: InventoryBalanceService,
    private readonly receiptService: StockReceiptService,
  ) {}

  @Get()
  async listBalances(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: QueryBalancesDto,
  ) {
    return this.balanceService.listBalances(user.tenantId, query);
  }

  @Get(':warehouseId/:productId')
  async getBalance(
    @CurrentUser() user: AuthenticatedUser,
    @Param('warehouseId', ParseUUIDPipe) warehouseId: string,
    @Param('productId', ParseUUIDPipe) productId: string,
  ) {
    return this.balanceService.getBalance(user.tenantId, warehouseId, productId);
  }

  @Patch(':warehouseId/:productId/adjust')
  async adjustStock(
    @CurrentUser() user: AuthenticatedUser,
    @Param('warehouseId', ParseUUIDPipe) warehouseId: string,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() dto: AdjustStockDto,
  ) {
    return this.receiptService.adjustStock(user, warehouseId, productId, dto);
  }

  @Patch(':warehouseId/:productId/threshold')
  async updateThreshold(
    @CurrentUser() user: AuthenticatedUser,
    @Param('warehouseId', ParseUUIDPipe) warehouseId: string,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() dto: UpdateLowStockThresholdDto,
  ) {
    return this.balanceService.updateLowStockThreshold(
      user.tenantId,
      warehouseId,
      productId,
      dto,
    );
  }
}
