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
  MASTER_DATA_PERMISSIONS,
  ORDER_PERMISSIONS,
  PermissionsGuard,
  RequirePermissions,
} from '@logix/auth';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard.js';
import { CurrentUser } from '../../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface.js';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto.js';
import { DisableRecordDto } from '../common/dto/disable-record.dto.js';
import { CustomerService } from './services/customer.service.js';
import { CreateCustomerDto, UpdateCustomerDto } from './dto/customer.dto.js';

@Controller('customers')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class CustomersController {
  constructor(private readonly customers: CustomerService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(MASTER_DATA_PERMISSIONS.CUSTOMER_MANAGE)
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateCustomerDto,
  ) {
    return this.customers.create(user.tenantId, dto);
  }

  @Get()
  @RequirePermissions(
    MASTER_DATA_PERMISSIONS.CUSTOMER_READ,
    MASTER_DATA_PERMISSIONS.CUSTOMER_MANAGE,
    ORDER_PERMISSIONS.SALES_ORDER_READ,
  )
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: PaginationQueryDto,
  ) {
    return this.customers.list(user.tenantId, query);
  }

  @Get(':id')
  @RequirePermissions(
    MASTER_DATA_PERMISSIONS.CUSTOMER_READ,
    MASTER_DATA_PERMISSIONS.CUSTOMER_MANAGE,
    ORDER_PERMISSIONS.SALES_ORDER_READ,
  )
  async getById(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.customers.getById(user.tenantId, id);
  }

  @Patch(':id')
  @RequirePermissions(MASTER_DATA_PERMISSIONS.CUSTOMER_MANAGE)
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCustomerDto,
  ) {
    return this.customers.update(user.tenantId, id, dto);
  }

  @Post(':id/disable')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(MASTER_DATA_PERMISSIONS.CUSTOMER_MANAGE)
  async disable(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DisableRecordDto,
  ) {
    return this.customers.disable(user.tenantId, id, dto.reason);
  }

  @Post(':id/enable')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(MASTER_DATA_PERMISSIONS.CUSTOMER_MANAGE)
  async enable(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.customers.enable(user.tenantId, id);
  }
}
