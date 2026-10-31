import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  AllowInternalCallers,
  InternalCaller,
  InternalServiceGuard,
  type InternalServiceTokenClaims,
} from '@logix/auth';
import { ServiceId } from '@logix/common';
import {
  shipmentClaimRequestSchema,
  shipmentReleaseRequestSchema,
  batchDispatchGrantRequestSchema,
} from '@logix/messaging';
import { z } from 'zod';
import { ShipmentPoolService } from './shipment-pool.service.js';
import { ShipmentTripClaimService } from './shipment-trip-claim.service.js';
import { ShipmentDispatchBatchService } from './shipment-dispatch-batch.service.js';

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new BadRequestException('Invalid request body');
  return parsed.data;
}

function assertTenant(
  caller: InternalServiceTokenClaims,
  bodyTenantId: string,
): void {
  if (bodyTenantId !== caller.tenantId)
    throw new ForbiddenException('Tenant does not match authenticated caller');
}

@Controller('internal/shipments')
@UseGuards(InternalServiceGuard)
@AllowInternalCallers(ServiceId.TRANSPORT_SERVICE)
export class InternalShipmentTripController {
  constructor(
    private readonly claims: ShipmentTripClaimService,
    private readonly pool: ShipmentPoolService,
    private readonly dispatches: ShipmentDispatchBatchService,
  ) {}

  @Post('dispatch-readiness')
  @HttpCode(200)
  dispatchReadiness(@InternalCaller() caller: InternalServiceTokenClaims, @Body() body: unknown) {
    const request = parseBody(z.object({
      tripId: z.string().uuid(),
      shipments: z.array(z.object({ shipmentId: z.string().uuid(), shipmentVersion: z.number().int().positive().safe() }).strict()).min(1).max(100),
    }).strict(), body);
    return this.dispatches.readiness(caller.tenantId, request.tripId, request.shipments);
  }

  @Post('dispatch-batch')
  @HttpCode(200)
  dispatchBatch(@InternalCaller() caller: InternalServiceTokenClaims, @Body() body: unknown) {
    const request = parseBody(batchDispatchGrantRequestSchema, body);
    assertTenant(caller, request.tenantId);
    return this.dispatches.dispatch(request);
  }

  @Get('dispatch-batches/:requestId')
  dispatchReceipt(@InternalCaller() caller: InternalServiceTokenClaims,
    @Param('requestId', ParseUUIDPipe) requestId: string) {
    return this.dispatches.receipt(caller.tenantId, requestId);
  }

  @Post('claim')
  @HttpCode(200)
  claim(
    @InternalCaller() caller: InternalServiceTokenClaims,
    @Body() body: unknown,
  ) {
    const request = parseBody(shipmentClaimRequestSchema, body);
    assertTenant(caller, request.tenantId);
    return this.claims.claim(request);
  }

  @Post('release')
  @HttpCode(200)
  release(
    @InternalCaller() caller: InternalServiceTokenClaims,
    @Body() body: unknown,
  ) {
    const request = parseBody(shipmentReleaseRequestSchema, body);
    assertTenant(caller, request.tenantId);
    return this.claims.release(request);
  }

  @Get('pool')
  poolList(
    @InternalCaller() caller: InternalServiceTokenClaims,
    @Query() query: Record<string, unknown>,
  ) {
    return this.pool.list(caller.tenantId, query, query.excludedShipmentIds);
  }

  @Get('receipts/:requestId')
  receipt(
    @InternalCaller() caller: InternalServiceTokenClaims,
    @Param('requestId', ParseUUIDPipe) requestId: string,
  ) {
    return this.claims.receipt(caller.tenantId, requestId);
  }

  @Get('claims/:claimId/status')
  claimStatus(
    @InternalCaller() caller: InternalServiceTokenClaims,
    @Param('claimId', ParseUUIDPipe) claimId: string,
  ) {
    return this.claims.claimStatus(caller.tenantId, claimId);
  }
}
