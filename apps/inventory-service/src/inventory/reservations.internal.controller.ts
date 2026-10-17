import { randomUUID } from 'node:crypto';
import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  AllowInternalCallers,
  InternalCaller,
  InternalServiceGuard,
  type InternalServiceTokenClaims,
} from '@logix/auth';
import { ReserveDto } from './dto/reserve.dto.js';
import { ReleaseDto } from './dto/release.dto.js';
import { ReservationService } from './services/reservation.service.js';

@Controller('internal/reservations')
@UseGuards(InternalServiceGuard)
@AllowInternalCallers('order-service')
export class ReservationsInternalController {
  constructor(private readonly reservations: ReservationService) {}

  @Get(':orderId/active')
  active(
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @InternalCaller() caller: InternalServiceTokenClaims,
  ) {
    return this.reservations.active(orderId, caller.tenantId);
  }

  @Post()
  reserve(
    @Body() dto: ReserveDto,
    @Headers('idempotency-key') key: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @InternalCaller() caller: InternalServiceTokenClaims,
  ) {
    return this.reservations.reserve(dto, key, {
      tenantId: caller.tenantId,
      correlationId: correlationId ?? randomUUID(),
    });
  }

  @Post('preview')
  preview(
    @Body() dto: ReserveDto,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @InternalCaller() caller: InternalServiceTokenClaims,
  ) {
    return this.reservations.preview(dto, {
      tenantId: caller.tenantId,
      correlationId: correlationId ?? randomUUID(),
    });
  }

  @Post('release')
  release(
    @Body() dto: ReleaseDto,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @InternalCaller() caller: InternalServiceTokenClaims,
  ) {
    return this.reservations.release(dto.orderId, {
      tenantId: caller.tenantId,
      correlationId: correlationId ?? randomUUID(),
    });
  }
}
