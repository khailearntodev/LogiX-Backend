import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  PermissionsGuard,
  RequirePermissions,
  TRANSPORT_PERMISSIONS,
} from '@logix/auth';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard.js';
import { CurrentUser } from '../../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface.js';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto.js';
import { RecordStatus } from '../common/master-data.constants.js';
import { VehicleService } from './services/vehicle.service.js';
import { CreateVehicleDto, UpdateVehicleDto } from './dto/vehicle.dto.js';

@Controller('vehicles')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class VehiclesController {
  constructor(private readonly vehicles: VehicleService) { }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(TRANSPORT_PERMISSIONS.VEHICLE_MANAGE)
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateVehicleDto,
  ) {
    return this.vehicles.create(user.tenantId, dto);
  }

  @Get()
  @RequirePermissions(
    TRANSPORT_PERMISSIONS.VEHICLE_READ,
    TRANSPORT_PERMISSIONS.VEHICLE_MANAGE,
    TRANSPORT_PERMISSIONS.TRIP_READ,
  )
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: PaginationQueryDto,
  ) {
    return this.vehicles.list(user.tenantId, query);
  }

  @Get(':id')
  @RequirePermissions(
    TRANSPORT_PERMISSIONS.VEHICLE_READ,
    TRANSPORT_PERMISSIONS.VEHICLE_MANAGE,
    TRANSPORT_PERMISSIONS.TRIP_READ,
  )
  async getById(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.vehicles.getById(user.tenantId, id);
  }

  @Patch(':id')
  @RequirePermissions(TRANSPORT_PERMISSIONS.VEHICLE_MANAGE)
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateVehicleDto,
  ) {
    return this.vehicles.update(user.tenantId, id, dto);
  }

  @Post(':id/disable')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(TRANSPORT_PERMISSIONS.VEHICLE_MANAGE)
  async disable(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.vehicles.setStatus(user.tenantId, id, RecordStatus.INACTIVE);
  }

  @Post(':id/enable')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(TRANSPORT_PERMISSIONS.VEHICLE_MANAGE)
  async enable(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.vehicles.setStatus(user.tenantId, id, RecordStatus.ACTIVE);
  }
}
