import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  CurrentUser,
  JwtAuthGuard,
  PermissionsGuard,
  RequirePermissions,
  type AuthenticatedUser,
} from '@logix/auth';
import { ORDER_PERMISSIONS } from './domain/order-permissions.js';

@Controller('orders')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class OrdersHealthController {
  @Get('health')
  @RequirePermissions(ORDER_PERMISSIONS.READ)
  health(@CurrentUser() user: AuthenticatedUser) {
    return { status: 'ok', tenantId: user.tenantId };
  }
}
