import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { CurrentUser, JwtAuthGuard, PermissionsGuard, RequirePermissions, TRANSPORT_PERMISSIONS as P, type AuthenticatedUser } from '@logix/auth';
import {
  approveTripRouteSchema, manualTripRouteSchema, optimizeTripRouteSchema,
  overrideTripRouteSchema, reopenTripSchema, tripRoutePreviewSchema,
} from '@logix/messaging';
import { parseDto } from '../trips/trip-serialization.js';
import { RoutePlanService } from './route-plan.service.js';
import { RouteApprovalService } from './route-approval.service.js';

@Controller('trips/:tripId')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class TripRouteController {
  constructor(private readonly plans: RoutePlanService, private readonly approval: RouteApprovalService) {}
  @Get('route-plans')
  @RequirePermissions(P.ROUTE_READ)
  list(@CurrentUser() user: AuthenticatedUser, @Param('tripId', ParseUUIDPipe) tripId: string) {
    return this.plans.list(user.tenantId, tripId);
  }
  @Get('route-plans/:planId')
  @RequirePermissions(P.ROUTE_READ)
  get(@CurrentUser() user: AuthenticatedUser, @Param('tripId', ParseUUIDPipe) tripId: string, @Param('planId', ParseUUIDPipe) planId: string) {
    return this.plans.get(user.tenantId, tripId, planId);
  }
  @Post('route-plans/manual')
  @RequirePermissions(P.ROUTE_APPROVE)
  manual(@CurrentUser() user: AuthenticatedUser, @Param('tripId', ParseUUIDPipe) tripId: string, @Headers('authorization') auth: string, @Body() raw: unknown) {
    return this.plans.manual(user, tripId, parseDto(manualTripRouteSchema, raw), auth);
  }
  @Post('route-optimizations')
  @RequirePermissions(P.ROUTE_OPTIMIZE)
  optimize(@CurrentUser() user: AuthenticatedUser, @Param('tripId', ParseUUIDPipe) tripId: string, @Headers('authorization') auth: string, @Body() raw: unknown) {
    return this.plans.optimize(user, tripId, parseDto(optimizeTripRouteSchema, raw), auth);
  }
  @Post('route-approval-preview')
  @HttpCode(200)
  @RequirePermissions(P.ROUTE_APPROVE)
  preview(@CurrentUser() user: AuthenticatedUser, @Param('tripId', ParseUUIDPipe) tripId: string, @Headers('authorization') auth: string, @Body() raw: unknown) {
    return this.approval.preview(user, tripId, parseDto(tripRoutePreviewSchema, raw), auth);
  }
  @Post('approve-route')
  @HttpCode(200)
  @RequirePermissions(P.ROUTE_APPROVE)
  approve(@CurrentUser() user: AuthenticatedUser, @Param('tripId', ParseUUIDPipe) tripId: string, @Headers('authorization') auth: string, @Body() raw: unknown) {
    return this.approval.approve(user, tripId, parseDto(approveTripRouteSchema, raw), auth);
  }
  @Post('override-route')
  @HttpCode(200)
  @RequirePermissions(P.ROUTE_APPROVE)
  override(@CurrentUser() user: AuthenticatedUser, @Param('tripId', ParseUUIDPipe) tripId: string, @Headers('authorization') auth: string, @Body() raw: unknown) {
    return this.approval.approve(user, tripId, parseDto(overrideTripRouteSchema, raw), auth);
  }
  @Post('reopen')
  @HttpCode(200)
  @RequirePermissions(P.TRIP_UPDATE)
  reopen(@CurrentUser() user: AuthenticatedUser, @Param('tripId', ParseUUIDPipe) tripId: string, @Body() raw: unknown) {
    return this.approval.reopen(user, tripId, parseDto(reopenTripSchema, raw));
  }
}
