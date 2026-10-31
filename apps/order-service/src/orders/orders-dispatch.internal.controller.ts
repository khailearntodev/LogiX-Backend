import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
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
import { batchDispatchGrantRequestSchema } from '@logix/messaging';
import { OrderDispatchBatchService } from './services/order-dispatch-batch.service.js';

@Controller('internal/orders')
@UseGuards(InternalServiceGuard)
@AllowInternalCallers(ServiceId.FULFILLMENT_SERVICE)
export class OrdersDispatchInternalController {
  constructor(
    private readonly dispatch: OrderDispatchService,
    private readonly batches: OrderDispatchBatchService,
  ) {}

  @Post('authorize-dispatch-batch')
  authorizeBatch(@Body() body: unknown, @InternalCaller() caller: InternalServiceTokenClaims) {
    const parsed = batchDispatchGrantRequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Yêu cầu dispatch batch không hợp lệ');
    if (parsed.data.tenantId !== caller.tenantId) throw new ForbiddenException();
    return this.batches.authorize(parsed.data);
  }

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
