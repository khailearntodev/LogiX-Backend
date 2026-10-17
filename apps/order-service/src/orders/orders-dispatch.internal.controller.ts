import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import { ServiceId } from '@logix/common';
import {
  AllowInternalCallers,
  InternalCaller,
  InternalServiceGuard,
  type InternalServiceTokenClaims,
} from '@logix/auth';
import { AuthorizeDispatchDto } from './dto/authorize-dispatch.dto.js';
import { OrderDispatchService } from './services/order-dispatch.service.js';

@Controller('internal/orders')
@UseGuards(InternalServiceGuard)
@AllowInternalCallers(ServiceId.FULFILLMENT_SERVICE)
export class OrdersDispatchInternalController {
  constructor(private readonly dispatch: OrderDispatchService) {}

  @Post(':orderId/authorize-dispatch')
  authorize(
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: AuthorizeDispatchDto,
    @InternalCaller() caller: InternalServiceTokenClaims,
    @Headers('x-correlation-id') correlationId: string | undefined,
  ) {
    if (!isUUID(caller.tenantId)) {
      throw new UnauthorizedException(
        'Tổ chức trong token nội bộ không hợp lệ',
      );
    }
    if (correlationId !== undefined && !isUUID(correlationId)) {
      throw new BadRequestException('Mã truy vết phải là UUID hợp lệ');
    }
    return this.dispatch.authorize(
      caller.tenantId,
      orderId,
      dto,
      correlationId ?? randomUUID(),
    );
  }
}
