import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { InventoryBalancesController } from './inventory-balances.controller.js';
import { StockMovementsController } from './stock-movements.controller.js';
import { StockReceiptsController } from './stock-receipts.controller.js';
import { InventoryBalanceService } from './services/inventory-balance.service.js';
import { StockMovementService } from './services/stock-movement.service.js';
import { StockReceiptService } from './services/stock-receipt.service.js';

@Module({
  imports: [AuthModule],
  controllers: [
    InventoryBalancesController,
    StockMovementsController,
    StockReceiptsController,
  ],
  providers: [InventoryBalanceService, StockMovementService, StockReceiptService],
  exports: [InventoryBalanceService, StockMovementService],
})
export class InventoryModule {}
