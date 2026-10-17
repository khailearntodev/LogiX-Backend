import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  CurrentUser,
  JwtAuthGuard,
  PermissionsGuard,
  RequirePermissions,
  type AuthenticatedUser,
} from '@logix/auth';
import {
  SHIPMENT_STATUS as S,
  SHIPMENT_PERMISSIONS as P,
} from '@logix/messaging';
import { randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import {
  CompleteShipmentDto,
  DispatchShipmentDto,
  FailShipmentDto,
  ShipmentQueryDto,
  ShipmentVersionDto,
} from './shipment.dto.js';
import { ShipmentQueryService } from './shipment-query.service.js';
import { ShipmentCommandService } from './shipment-command.service.js';
import { ShipmentDispatchService } from './shipment-dispatch.service.js';

function context(user: AuthenticatedUser, correlation?: string) {
  if (correlation !== undefined && !isUUID(correlation))
    throw new BadRequestException('Mã truy vết không hợp lệ');
  return {
    tenantId: user.tenantId,
    actorId: user.id,
    correlationId: correlation ?? randomUUID(),
  };
}
@Controller('shipments')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ShipmentsController {
  constructor(
    private readonly queries: ShipmentQueryService,
    private readonly commands: ShipmentCommandService,
    private readonly dispatching: ShipmentDispatchService,
  ) {}
  @Get()
  @RequirePermissions(P.READ)
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ShipmentQueryDto,
  ) {
    return this.queries.list(user.tenantId, query);
  }
  @Get(':id')
  @RequirePermissions(P.READ)
  detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.queries.detail(user.tenantId, id);
  }
  @Post(':id/start-picking')
  @HttpCode(200)
  @RequirePermissions(P.UPDATE)
  picking(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ShipmentVersionDto,
    @Headers('x-correlation-id') correlation?: string,
  ) {
    return this.commands.transition(
      id,
      dto.version,
      S.PICKING,
      context(user, correlation),
    );
  }
  @Post(':id/mark-ready')
  @HttpCode(200)
  @RequirePermissions(P.UPDATE)
  ready(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ShipmentVersionDto,
    @Headers('x-correlation-id') correlation?: string,
  ) {
    return this.commands.transition(
      id,
      dto.version,
      S.READY_TO_SHIP,
      context(user, correlation),
    );
  }
  @Get(':id/dispatch-preview')
  @RequirePermissions(P.READ)
  preview(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('x-correlation-id') correlation?: string,
  ) {
    return this.dispatching.preview(id, context(user, correlation));
  }
  @Post(':id/dispatch')
  @HttpCode(200)
  @RequirePermissions(P.DISPATCH)
  dispatch(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DispatchShipmentDto,
    @Headers('x-correlation-id') correlation?: string,
  ) {
    return this.dispatching.dispatch(id, dto, context(user, correlation));
  }
  @Post(':id/mark-delivered')
  @HttpCode(200)
  @RequirePermissions(P.COMPLETE)
  delivered(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CompleteShipmentDto,
    @Headers('x-correlation-id') correlation?: string,
  ) {
    return this.commands.transition(
      id,
      dto.version,
      S.DELIVERED,
      context(user, correlation),
    );
  }
  @Post(':id/mark-failed')
  @HttpCode(200)
  @RequirePermissions(P.COMPLETE)
  failed(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: FailShipmentDto,
    @Headers('x-correlation-id') correlation?: string,
  ) {
    return this.commands.transition(
      id,
      dto.version,
      S.FAILED,
      context(user, correlation),
      dto.reason,
    );
  }
}
