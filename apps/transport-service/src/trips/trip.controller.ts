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
import type { Response } from 'express';
import { EntityNotFoundError } from '@logix/errors';
import {
  CurrentUser,
  RequirePermissions,
  TRANSPORT_PERMISSIONS,
  type AuthenticatedUser,
} from '@logix/auth';
import { JwtAuthGuard, PermissionsGuard } from '@logix/auth';
import {
  addShipmentsSchema,
  assignmentSchema,
  cancelPreviewSchema,
  cancelTripSchema,
  createTripSchema,
  eligibleShipmentsQuerySchema,
  removeShipmentsSchema,
  tripListQuerySchema,
  updateTripSchema,
} from './trip.dto.js';
import { TripCancellationService } from './trip-cancellation.service.js';
import { TripCommandService } from './trip-command.service.js';
import { TripMembershipService } from './trip-membership.service.js';
import { TripQueryService } from './trip-query.service.js';
import { parseDto } from './trip-serialization.js';
import { TripConflictError } from './trip-conflict.error.js';
import { TripDispatchService } from '../dispatch/trip-dispatch.service.js';
import { tripDispatchCommandSchema, tripDispatchPreviewRequestSchema } from '@logix/messaging';

@Controller('trips')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class TripController {
  constructor(
    private readonly queries: TripQueryService,
    private readonly commands: TripCommandService,
    private readonly memberships: TripMembershipService,
    private readonly cancellation: TripCancellationService,
    private readonly dispatches: TripDispatchService,
  ) {}

  @Post(':tripId/dispatch-preview')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(TRANSPORT_PERMISSIONS.TRIP_DISPATCH)
  dispatchPreview(@CurrentUser() user: AuthenticatedUser,
    @Param('tripId', ParseUUIDPipe) tripId: string, @Body() body: unknown) {
    return this.dispatches.preview(user, tripId, parseDto(tripDispatchPreviewRequestSchema, body).version);
  }

  @Post(':tripId/dispatch')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(TRANSPORT_PERMISSIONS.TRIP_DISPATCH)
  async dispatch(@CurrentUser() user: AuthenticatedUser,
    @Param('tripId', ParseUUIDPipe) tripId: string, @Body() body: unknown,
    @Res({ passthrough: true }) response: Response) {
    const result = await this.dispatches.dispatch(user, tripId, parseDto(tripDispatchCommandSchema, body));
    response.status(result?.status === 'PENDING' ? HttpStatus.ACCEPTED : HttpStatus.OK);
    return result;
  }

  @Get('eligible-shipments')
  @RequirePermissions(TRANSPORT_PERMISSIONS.TRIP_CREATE)
  eligibleShipments(
    @CurrentUser() user: AuthenticatedUser,
    @Headers('authorization') authorization: string,
    @Query() rawQuery: Record<string, unknown>,
  ) {
    const query = parseDto(eligibleShipmentsQuerySchema, rawQuery);
    return this.queries.eligibleShipments(
      user.tenantId,
      query.warehouseId,
      query.page,
      query.pageSize,
      authorization,
    );
  }

  @Get()
  @RequirePermissions(TRANSPORT_PERMISSIONS.TRIP_READ)
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() rawQuery: Record<string, unknown>,
  ) {
    return this.queries.list(
      user.tenantId,
      parseDto(tripListQuerySchema, rawQuery),
    );
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(TRANSPORT_PERMISSIONS.TRIP_CREATE)
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Headers('authorization') authorization: string,
    @Body() rawBody: unknown,
  ) {
    return this.commands.create(
      user,
      parseDto(createTripSchema, rawBody),
      authorization,
    );
  }

  @Get(':tripId')
  @RequirePermissions(TRANSPORT_PERMISSIONS.TRIP_READ)
  async get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('tripId', ParseUUIDPipe) tripId: string,
  ) {
    const trip = await this.queries.get(user.tenantId, tripId);
    if (!trip) {
      throw new EntityNotFoundError('DeliveryTrip', tripId);
    }
    return trip;
  }

  @Patch(':tripId')
  @RequirePermissions(TRANSPORT_PERMISSIONS.TRIP_UPDATE)
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Headers('authorization') authorization: string,
    @Param('tripId', ParseUUIDPipe) tripId: string,
    @Body() rawBody: unknown,
  ) {
    return this.commands.update(
      user,
      tripId,
      parseDto(updateTripSchema, rawBody),
      authorization,
    );
  }

  @Post(':tripId/assignment')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(TRANSPORT_PERMISSIONS.TRIP_UPDATE)
  assign(
    @CurrentUser() user: AuthenticatedUser,
    @Headers('authorization') authorization: string,
    @Param('tripId', ParseUUIDPipe) tripId: string,
    @Body() rawBody: unknown,
  ) {
    return this.commands.assign(
      user,
      tripId,
      parseDto(assignmentSchema, rawBody),
      authorization,
    );
  }

  @Post(':tripId/shipments')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(TRANSPORT_PERMISSIONS.TRIP_UPDATE)
  async addShipments(
    @CurrentUser() user: AuthenticatedUser,
    @Param('tripId', ParseUUIDPipe) tripId: string,
    @Body() rawBody: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.memberships.add(
      user,
      tripId,
      parseDto(addShipmentsSchema, rawBody),
    );
    if (!result) throw new EntityNotFoundError('TripOperation', 'unknown');
    if (result.status === 'REJECTED') {
      throw new TripConflictError('TRIP_MEMBERSHIP_OPERATION_REJECTED', {
        requestId: result.requestId,
        results: result.results,
      });
    }
    response.status(result.status === 'PENDING' ? HttpStatus.ACCEPTED : HttpStatus.OK);
    return result;
  }

  @Post(':tripId/shipments/remove')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(TRANSPORT_PERMISSIONS.TRIP_UPDATE)
  async removeShipments(
    @CurrentUser() user: AuthenticatedUser,
    @Param('tripId', ParseUUIDPipe) tripId: string,
    @Body() rawBody: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.memberships.remove(
      user,
      tripId,
      parseDto(removeShipmentsSchema, rawBody),
    );
    if (!result) throw new EntityNotFoundError('TripOperation', 'unknown');
    response.status(result.status === 'PENDING' ? HttpStatus.ACCEPTED : HttpStatus.OK);
    return result;
  }

  @Get(':tripId/operations/:requestId')
  @RequirePermissions(TRANSPORT_PERMISSIONS.TRIP_READ)
  async operation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('tripId', ParseUUIDPipe) tripId: string,
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const dispatch = await this.dispatches.operation(user.tenantId, tripId, requestId);
    if (dispatch) {
      await this.dispatches.resume(user.tenantId, requestId);
      const result = await this.dispatches.operation(user.tenantId, tripId, requestId);
      response.status(result?.status === 'PENDING' ? HttpStatus.ACCEPTED : HttpStatus.OK);
      return result;
    }
    const operation = await this.memberships.operationView(user.tenantId, requestId);
    if (!operation || operation.tripId !== tripId) {
      throw new EntityNotFoundError('TripOperation', requestId);
    }
    await this.memberships.resumeByRequest(user.tenantId, requestId, true);
    const result = await this.memberships.operationView(user.tenantId, requestId);
    if (!result || result.tripId !== tripId) {
      throw new EntityNotFoundError('TripOperation', requestId);
    }
    response.status(result.status === 'PENDING' ? HttpStatus.ACCEPTED : HttpStatus.OK);
    return result;
  }

  @Post(':tripId/cancel-preview')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(TRANSPORT_PERMISSIONS.TRIP_UPDATE)
  cancelPreview(
    @CurrentUser() user: AuthenticatedUser,
    @Param('tripId', ParseUUIDPipe) tripId: string,
    @Body() rawBody: unknown,
  ) {
    const dto = parseDto(cancelPreviewSchema, rawBody);
    return this.cancellation.preview(user, tripId, dto.expectedVersion);
  }

  @Post(':tripId/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(TRANSPORT_PERMISSIONS.TRIP_UPDATE)
  async cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('tripId', ParseUUIDPipe) tripId: string,
    @Body() rawBody: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.cancellation.cancel(
      user,
      tripId,
      parseDto(cancelTripSchema, rawBody),
    );
    if (!result) throw new EntityNotFoundError('TripOperation', 'unknown');
    response.status(result.status === 'PENDING' ? HttpStatus.ACCEPTED : HttpStatus.OK);
    return result;
  }
}
