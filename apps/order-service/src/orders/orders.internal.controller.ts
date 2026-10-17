import { Body, Controller, Headers, Post, UseGuards } from '@nestjs/common';
import {
  AllowInternalCallers,
  InternalCaller,
  InternalServiceGuard,
  type InternalServiceTokenClaims,
} from '@logix/auth';
import { randomUUID } from 'node:crypto';
import { ReconcileReservationDto } from './dto/reconcile-reservation.dto.js';
import { OrderReservationService } from './services/order-reservation.service.js';

@Controller('internal/orders')
@UseGuards(InternalServiceGuard)
@AllowInternalCallers('inventory-service')
export class OrdersInternalController {
  constructor(private readonly reservations: OrderReservationService) {}

  @Post('reconcile-reservation')
  reconcile(
    @Body() dto: ReconcileReservationDto,
    @InternalCaller() caller: InternalServiceTokenClaims,
    @Headers('x-correlation-id') correlationId: string | undefined,
  ) {
    return this.reservations.reconcile(dto, {
      tenantId: caller.tenantId,
      actorId: null,
      correlationId: correlationId ?? randomUUID(),
    });
  }
}
