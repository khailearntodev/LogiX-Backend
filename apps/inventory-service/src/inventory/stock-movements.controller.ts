import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface.js';
import { InventoryBalanceService } from './services/inventory-balance.service.js';
import { QueryMovementsDto } from './dto/query-movements.dto.js';

@Controller('inventory/movements')
@UseGuards(JwtAuthGuard)
export class StockMovementsController {
  constructor(private readonly balanceService: InventoryBalanceService) {}

  @Get()
  async listMovements(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: QueryMovementsDto,
  ) {
    return this.balanceService.listMovements(user.tenantId, query);
  }
}
