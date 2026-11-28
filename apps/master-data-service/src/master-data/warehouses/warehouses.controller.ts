import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  FORECAST_PERMISSIONS,
  INVENTORY_PERMISSIONS,
  ORDER_PERMISSIONS,
  PermissionsGuard,
  RequirePermissions,
  TRANSPORT_PERMISSIONS,
} from '@logix/auth';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard.js';
import { CurrentUser } from '../../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface.js';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto.js';
import { RecordStatus } from '../common/master-data.constants.js';
import { WarehouseService } from './services/warehouse.service.js';
import { CreateWarehouseDto } from './dto/create-warehouse.dto.js';
import { UpdateWarehouseDto } from './dto/update-warehouse.dto.js';

@Controller('warehouses')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class WarehousesController {
  constructor(private readonly warehouses: WarehouseService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(INVENTORY_PERMISSIONS.WAREHOUSE_CREATE)
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateWarehouseDto,
  ) {
    return this.warehouses.create(user.tenantId, dto);
  }

  @Get()
  @RequirePermissions(
    INVENTORY_PERMISSIONS.WAREHOUSE_READ,
    INVENTORY_PERMISSIONS.WAREHOUSE_CREATE,
    INVENTORY_PERMISSIONS.WAREHOUSE_UPDATE,
    INVENTORY_PERMISSIONS.STOCK_READ,
    ORDER_PERMISSIONS.SALES_ORDER_READ,
    TRANSPORT_PERMISSIONS.TRIP_READ,
    FORECAST_PERMISSIONS.READ,
  )
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: PaginationQueryDto,
  ) {
    return this.warehouses.list(user.tenantId, query);
  }

  @Get(':id')
  @RequirePermissions(
    INVENTORY_PERMISSIONS.WAREHOUSE_READ,
    INVENTORY_PERMISSIONS.WAREHOUSE_CREATE,
    INVENTORY_PERMISSIONS.WAREHOUSE_UPDATE,
    INVENTORY_PERMISSIONS.STOCK_READ,
    ORDER_PERMISSIONS.SALES_ORDER_READ,
    TRANSPORT_PERMISSIONS.TRIP_READ,
    FORECAST_PERMISSIONS.READ,
  )
  async getById(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.warehouses.getById(user.tenantId, id);
  }

  @Patch(':id')
  @RequirePermissions(INVENTORY_PERMISSIONS.WAREHOUSE_UPDATE)
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWarehouseDto,
  ) {
    return this.warehouses.update(user.tenantId, id, dto);
  }

  @Post(':id/disable')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(INVENTORY_PERMISSIONS.WAREHOUSE_UPDATE)
  async disable(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.warehouses.setStatus(user.tenantId, id, RecordStatus.INACTIVE);
  }

  @Post(':id/enable')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(INVENTORY_PERMISSIONS.WAREHOUSE_UPDATE)
  async enable(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.warehouses.setStatus(user.tenantId, id, RecordStatus.ACTIVE);
  }
}
