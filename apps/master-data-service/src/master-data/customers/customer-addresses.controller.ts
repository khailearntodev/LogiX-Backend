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
@UseGuards(JwtAuthGuard)
export class CustomerAddressesController {
  constructor(private readonly addresses: CustomerAddressService) {}

  @Get()
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('customerId', ParseUUIDPipe) customerId: string,
  ) {
    return this.addresses.list(user.tenantId, customerId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Body() dto: CreateCustomerAddressDto,
  ) {
    return this.addresses.create(user.tenantId, customerId, dto);
  }

  @Patch(':addressId')
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
  async setDefault(
    @CurrentUser() user: AuthenticatedUser,
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Param('addressId', ParseUUIDPipe) addressId: string,
  ) {
    return this.addresses.setDefault(user.tenantId, customerId, addressId);
  }

  @Post(':addressId/disable')
  @HttpCode(HttpStatus.OK)
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
