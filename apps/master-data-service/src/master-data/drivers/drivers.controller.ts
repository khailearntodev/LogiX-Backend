import {
  Body,
  BadRequestException,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  MASTER_DATA_DRIVER_PERMISSIONS,
  PermissionsGuard,
  RequirePermissions,
} from '@logix/auth';
import { isUUID } from 'class-validator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard.js';
import { CurrentUser } from '../../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface.js';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto.js';
import { RecordStatus } from '../common/master-data.constants.js';
import {
  CreateDriverDto,
  EligibleDriverUsersQueryDto,
  DriverVersionDto,
  UpdateDriverDto,
  RelinkDriverUserDto,
} from './dto/driver.dto.js';
import { DriverService } from './driver.service.js';
import { IdentityDriverClient } from './identity-driver.client.js';
import { DriverLinkService } from './driver-link.service.js';

const DRIVER_READ = MASTER_DATA_DRIVER_PERMISSIONS.READ;
const DRIVER_MANAGE = MASTER_DATA_DRIVER_PERMISSIONS.MANAGE;

@Controller('drivers')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class DriversController {
  constructor(
    @Inject(DriverService) private readonly drivers: DriverService,
    @Inject(IdentityDriverClient)
    private readonly identity: IdentityDriverClient,
    @Inject(DriverLinkService) private readonly links: DriverLinkService,
  ) {}
  private tenant(user: AuthenticatedUser) {
    if (!isUUID(user.tenantId))
      throw new UnauthorizedException('Chưa chọn tổ chức hợp lệ');
    return user.tenantId;
  }

  @Get('eligible-users')
  @RequirePermissions(DRIVER_MANAGE)
  eligibleUsers(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: EligibleDriverUsersQueryDto,
  ) {
    return this.identity.list(this.tenant(user), query);
  }

  @Get()
  @RequirePermissions(DRIVER_READ)
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: PaginationQueryDto,
  ) {
    return this.drivers.list(this.tenant(user), query);
  }

  @Get(':id')
  @RequirePermissions(DRIVER_READ)
  detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.drivers.getById(this.tenant(user), id);
  }

  @Post()
  @RequirePermissions(DRIVER_MANAGE)
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateDriverDto) {
    return this.drivers.create(this.tenant(user), dto);
  }

  @Patch(':id')
  @RequirePermissions(DRIVER_MANAGE)
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDriverDto,
  ) {
    return this.drivers.update(this.tenant(user), id, dto);
  }

  @Post(':id/enable')
  @HttpCode(200)
  @RequirePermissions(DRIVER_MANAGE)
  enable(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DriverVersionDto,
  ) {
    return this.drivers.setStatus(
      this.tenant(user),
      id,
      dto.version,
      RecordStatus.ACTIVE,
    );
  }

  @Post(':id/relink-user/preview')
  @HttpCode(200)
  @RequirePermissions(DRIVER_MANAGE)
  previewRelink(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RelinkDriverUserDto,
  ) {
    return this.links.preview(this.tenant(user), id, dto);
  }

  @Post(':id/relink-user')
  @HttpCode(200)
  @RequirePermissions(DRIVER_MANAGE)
  relink(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RelinkDriverUserDto,
    @Headers('x-correlation-id') correlationId: string | undefined,
  ) {
    if (!isUUID(user.id))
      throw new UnauthorizedException('Người thực hiện không hợp lệ');
    if (correlationId !== undefined && !isUUID(correlationId))
      throw new BadRequestException('Mã tương quan không hợp lệ');
    return this.links.relink(
      this.tenant(user),
      id,
      user.id,
      dto,
      correlationId,
    );
  }

  @Post(':id/disable')
  @HttpCode(200)
  @RequirePermissions(DRIVER_MANAGE)
  disable(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DriverVersionDto,
  ) {
    return this.drivers.setStatus(
      this.tenant(user),
      id,
      dto.version,
      RecordStatus.INACTIVE,
    );
  }
}
