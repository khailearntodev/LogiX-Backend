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
import { RecordStatus } from '../common/master-data.constants.js';
import { CustomerAddressService } from './services/customer-address.service.js';
import {
  CreateCustomerAddressDto,
  UpdateCustomerAddressDto,
} from './dto/customer-address.dto.js';

@Controller('customers/:customerId/addresses')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class CustomerAddressesController {
  constructor(private readonly addresses: CustomerAddressService) {}

  @Get()
  @RequirePermissions(
    MASTER_DATA_PERMISSIONS.CUSTOMER_READ,
    MASTER_DATA_PERMISSIONS.CUSTOMER_MANAGE,
    ORDER_PERMISSIONS.SALES_ORDER_READ,
  )
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('customerId', ParseUUIDPipe) customerId: string,
  ) {
    return this.addresses.list(user.tenantId, customerId);
  }

  @Get(':addressId')
  @RequirePermissions(
    MASTER_DATA_PERMISSIONS.CUSTOMER_READ,
    MASTER_DATA_PERMISSIONS.CUSTOMER_MANAGE,
    ORDER_PERMISSIONS.SALES_ORDER_READ,
  )
  async getById(
    @CurrentUser() user: AuthenticatedUser,
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Param('addressId', ParseUUIDPipe) addressId: string,
  ) {
    return this.addresses.getById(user.tenantId, customerId, addressId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(MASTER_DATA_PERMISSIONS.CUSTOMER_MANAGE)
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Body() dto: CreateCustomerAddressDto,
  ) {
    return this.addresses.create(user.tenantId, customerId, dto);
  }

  @Patch(':addressId')
  @RequirePermissions(MASTER_DATA_PERMISSIONS.CUSTOMER_MANAGE)
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Param('addressId', ParseUUIDPipe) addressId: string,
    @Body() dto: UpdateCustomerAddressDto,
  ) {
    return this.addresses.update(user.tenantId, customerId, addressId, dto);
  }

  @Post(':addressId/default')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(MASTER_DATA_PERMISSIONS.CUSTOMER_MANAGE)
  async setDefault(
    @CurrentUser() user: AuthenticatedUser,
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Param('addressId', ParseUUIDPipe) addressId: string,
  ) {
    return this.addresses.setDefault(user.tenantId, customerId, addressId);
  }

  @Post(':addressId/disable')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(MASTER_DATA_PERMISSIONS.CUSTOMER_MANAGE)
  async disable(
    @CurrentUser() user: AuthenticatedUser,
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Param('addressId', ParseUUIDPipe) addressId: string,
  ) {
    return this.addresses.setStatus(
      user.tenantId,
      customerId,
      addressId,
      RecordStatus.INACTIVE,
    );
  }

  @Post(':addressId/enable')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(MASTER_DATA_PERMISSIONS.CUSTOMER_MANAGE)
  async enable(
    @CurrentUser() user: AuthenticatedUser,
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Param('addressId', ParseUUIDPipe) addressId: string,
  ) {
    return this.addresses.setStatus(
      user.tenantId,
      customerId,
      addressId,
      RecordStatus.ACTIVE,
    );
  }
}
