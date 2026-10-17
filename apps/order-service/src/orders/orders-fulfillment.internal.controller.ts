import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  AllowInternalCallers,
  InternalCaller,
  InternalServiceGuard,
  type InternalServiceTokenClaims,
} from '@logix/auth';
import { ServiceId } from '@logix/common';
import { isUUID } from 'class-validator';
import { OrderQueryService } from './services/order-query.service.js';

@Controller('internal/orders')
@UseGuards(InternalServiceGuard)
@AllowInternalCallers(ServiceId.FULFILLMENT_SERVICE)
export class OrdersFulfillmentInternalController {
  constructor(private readonly queries: OrderQueryService) {}

  @Get(':orderId/fulfillment-snapshot')
  snapshot(
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @InternalCaller() caller: InternalServiceTokenClaims,
  ) {
    if (!isUUID(caller.tenantId))
      throw new UnauthorizedException('Tổ chức không hợp lệ');
    return this.queries.detail(caller.tenantId, orderId);
  }
}
