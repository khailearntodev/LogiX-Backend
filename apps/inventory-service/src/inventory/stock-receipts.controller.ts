import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface.js';
import { StockReceiptService } from './services/stock-receipt.service.js';
import { CreateStockReceiptDto } from './dto/create-stock-receipt.dto.js';

@Controller('inventory/receipts')
@UseGuards(JwtAuthGuard)
export class StockReceiptsController {
  constructor(private readonly receiptService: StockReceiptService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createReceipt(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateStockReceiptDto,
  ) {
    return this.receiptService.createReceipt(user, dto);
  }
}
