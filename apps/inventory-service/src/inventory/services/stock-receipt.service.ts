import { Injectable, NotImplementedException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { CreateStockReceiptDto } from '../dto/create-stock-receipt.dto.js';
import { AdjustStockDto } from '../dto/adjust-stock.dto.js';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface.js';
import type { InventoryBalanceView, StockReceiptView } from '../inventory.types.js';
import { StockMovementService } from './stock-movement.service.js';

@Injectable()
export class StockReceiptService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stockMovement: StockMovementService,
  ) {}

  /** All lines succeed or none: one transaction over header, lines and movements. */
  async createReceipt(
    _actor: AuthenticatedUser,
    _dto: CreateStockReceiptDto,
  ): Promise<StockReceiptView> {
    throw new NotImplementedException('createReceipt chưa được triển khai');
  }

  async adjustStock(
    _actor: AuthenticatedUser,
    _warehouseId: string,
    _productId: string,
    _dto: AdjustStockDto,
  ): Promise<InventoryBalanceView> {
    throw new NotImplementedException('adjustStock chưa được triển khai');
  }
}
