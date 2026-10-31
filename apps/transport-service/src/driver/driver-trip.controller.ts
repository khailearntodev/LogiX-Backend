import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
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
  TRANSPORT_PERMISSIONS,
  type AuthenticatedUser,
} from '@logix/auth';
import { parseDto } from '../trips/trip-serialization.js';
import {
  driverActionCommandSchema,
  driverActionPreviewSchema,
  driverTripListSchema,
} from './driver-trip.dto.js';
import { DriverTripService } from './driver-trip.service.js';

@Controller('driver/trips')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class DriverTripController {
  constructor(private readonly trips: DriverTripService) {}

  @Get()
  @RequirePermissions(TRANSPORT_PERMISSIONS.DRIVER_READ)
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: Record<string, unknown>,
  ) {
    return this.trips.list(user, parseDto(driverTripListSchema, query));
  }

  @Get(':tripId')
  @RequirePermissions(TRANSPORT_PERMISSIONS.DRIVER_READ)
  detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('tripId', ParseUUIDPipe) tripId: string,
  ) {
    return this.trips.detail(user, tripId);
  }

  @Post(':tripId/stops/:stopId/action-preview')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(TRANSPORT_PERMISSIONS.DRIVER_UPDATE)
  preview(
    @CurrentUser() user: AuthenticatedUser,
    @Param('tripId', ParseUUIDPipe) tripId: string,
    @Param('stopId', ParseUUIDPipe) stopId: string,
    @Body() body: unknown,
  ) {
    return this.trips.preview(
      user,
      tripId,
      stopId,
      parseDto(driverActionPreviewSchema, body),
    );
  }

  @Post(':tripId/stops/:stopId/deliver')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(TRANSPORT_PERMISSIONS.DRIVER_UPDATE)
  deliver(
    @CurrentUser() user: AuthenticatedUser,
    @Param('tripId', ParseUUIDPipe) tripId: string,
    @Param('stopId', ParseUUIDPipe) stopId: string,
    @Body() body: unknown,
  ) {
    return this.trips.deliver(
      user,
      tripId,
      stopId,
      parseDto(driverActionCommandSchema, body),
    );
  }

  @Post(':tripId/stops/:stopId/fail')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(TRANSPORT_PERMISSIONS.DRIVER_UPDATE)
  fail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('tripId', ParseUUIDPipe) tripId: string,
    @Param('stopId', ParseUUIDPipe) stopId: string,
    @Body() body: unknown,
  ) {
    return this.trips.fail(
      user,
      tripId,
      stopId,
      parseDto(driverActionCommandSchema, body),
    );
  }
}
