import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  CurrentUser,
  JwtAuthGuard,
  PermissionsGuard,
  RequirePermissions,
  type AuthenticatedUser,
} from '@logix/auth';
import type { Response } from 'express';
import { IDEMPOTENCY_KEY_HEADER } from './domain/order-constants.js';
import { ORDER_PERMISSIONS } from './domain/order-permissions.js';
import { CancelOrderDto } from './dto/cancel-order.dto.js';
import { CreateOrderDto } from './dto/create-order.dto.js';
import { ListOrdersQueryDto } from './dto/list-orders.query.js';
import { UpdateOrderDto } from './dto/update-order.dto.js';
import { OrderContext } from './order-context.decorator.js';
import type {
  OrderCommandContext,
  OrderDetailView,
  OrderHistoryView,
  OrderSummaryView,
  Paginated,
} from './order.types.js';
import { OrderCommandService } from './services/order-command.service.js';
import { OrderQueryService } from './services/order-query.service.js';
import { OrderReservationService } from './services/order-reservation.service.js';
import { ConfirmOrderDto } from './dto/confirm-order.dto.js';

const orderIdPipe = new ParseUUIDPipe({ version: '4' });

@Controller('orders')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class OrdersController {
  constructor(
    private readonly commands: OrderCommandService,
    private readonly queries: OrderQueryService,
    private readonly reservations: OrderReservationService,
  ) {}

  /** 201 for a new order, 200 when an identical request is replayed. */
  @Post()
  @RequirePermissions(ORDER_PERMISSIONS.CREATE)
  async create(
    @OrderContext() ctx: OrderCommandContext,
    @Headers(IDEMPOTENCY_KEY_HEADER) idempotencyKey: string | undefined,
    @Body() dto: CreateOrderDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OrderDetailView> {
    const result = await this.commands.create(dto, idempotencyKey, ctx);
    response.status(result.replayed ? HttpStatus.OK : HttpStatus.CREATED);
    return result.order;
  }

  @Get()
  @RequirePermissions(ORDER_PERMISSIONS.READ)
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListOrdersQueryDto,
  ): Promise<Paginated<OrderSummaryView>> {
    return this.queries.list(user.tenantId, query);
  }

  @Get(':id')
  @RequirePermissions(ORDER_PERMISSIONS.READ)
  detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', orderIdPipe) orderId: string,
  ): Promise<OrderDetailView> {
    return this.queries.detail(user.tenantId, orderId);
  }

  @Get(':id/history')
  @RequirePermissions(ORDER_PERMISSIONS.READ)
  history(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', orderIdPipe) orderId: string,
  ): Promise<OrderHistoryView[]> {
    return this.queries.history(user.tenantId, orderId);
  }

  @Patch(':id')
  @RequirePermissions(ORDER_PERMISSIONS.UPDATE)
  update(
    @OrderContext() ctx: OrderCommandContext,
    @Param('id', orderIdPipe) orderId: string,
    @Body() dto: UpdateOrderDto,
  ): Promise<OrderDetailView> {
    return this.commands.update(orderId, dto, ctx);
  }

  @Get(':id/confirm-preview')
  @RequirePermissions(ORDER_PERMISSIONS.APPROVE)
  preview(
    @OrderContext() ctx: OrderCommandContext,
    @Param('id', orderIdPipe) orderId: string,
  ) {
    return this.reservations.preview(orderId, ctx);
  }

  @Get(':id/shortages')
  @RequirePermissions(ORDER_PERMISSIONS.READ)
  shortages(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', orderIdPipe) orderId: string,
  ) {
    return this.reservations.shortages(user.tenantId, orderId);
  }

  @Post(':id/confirm')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(ORDER_PERMISSIONS.APPROVE)
  confirm(
    @OrderContext() ctx: OrderCommandContext,
    @Param('id', orderIdPipe) orderId: string,
    @Body() dto: ConfirmOrderDto,
  ) {
    return this.reservations.confirm(orderId, dto.version, ctx);
  }

  @Post(':id/retry-reservation')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(ORDER_PERMISSIONS.APPROVE)
  retry(
    @OrderContext() ctx: OrderCommandContext,
    @Param('id', orderIdPipe) orderId: string,
    @Body() dto: ConfirmOrderDto,
  ) {
    return this.reservations.confirm(orderId, dto.version, ctx, true);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(ORDER_PERMISSIONS.CANCEL)
  cancel(
    @OrderContext() ctx: OrderCommandContext,
    @Param('id', orderIdPipe) orderId: string,
    @Body() dto: CancelOrderDto,
  ): Promise<OrderDetailView> {
    return this.commands.cancel(orderId, dto, ctx);
  }
}
