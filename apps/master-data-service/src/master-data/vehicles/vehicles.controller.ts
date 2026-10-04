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
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard.js';
import { CurrentUser } from '../../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface.js';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto.js';
import { RecordStatus } from '../common/master-data.constants.js';
import { VehicleService } from './services/vehicle.service.js';
import { CreateVehicleDto, UpdateVehicleDto } from './dto/vehicle.dto.js';

@Controller('vehicles')
@UseGuards(JwtAuthGuard)
export class VehiclesController {
  constructor(private readonly vehicles: VehicleService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateVehicleDto,
  ) {
    return this.vehicles.create(user.tenantId, dto);
  }

  @Get()
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: PaginationQueryDto,
  ) {
    return this.vehicles.list(user.tenantId, query);
  }

  @Get(':id')
  async getById(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.vehicles.getById(user.tenantId, id);
  }

  @Patch(':id')
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateVehicleDto,
  ) {
    return this.vehicles.update(user.tenantId, id, dto);
  }

  @Post(':id/disable')
  @HttpCode(HttpStatus.OK)
  async disable(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.vehicles.setStatus(user.tenantId, id, RecordStatus.INACTIVE);
  }

  @Post(':id/enable')
  @HttpCode(HttpStatus.OK)
  async enable(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.vehicles.setStatus(user.tenantId, id, RecordStatus.ACTIVE);
  }
}
