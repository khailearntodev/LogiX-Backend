import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  AllowInternalCallers,
  InternalCaller,
  InternalServiceGuard,
  type InternalServiceTokenClaims,
} from '@logix/auth';
import { ServiceId } from '@logix/common';
import { isUUID } from 'class-validator';
import { DriverUsersService } from './driver-users.service.js';
import { DriverUsersQuery, ResolveDriverUsersDto } from './driver-users.dto.js';

@Controller('internal/driver-users')
@UseGuards(InternalServiceGuard)
@AllowInternalCallers(ServiceId.MASTER_DATA_SERVICE)
export class DriverUsersController {
  constructor(
    @Inject(DriverUsersService) private readonly users: DriverUsersService,
  ) {}

  private tenant(caller: InternalServiceTokenClaims) {
    if (!isUUID(caller.tenantId))
      throw new UnauthorizedException('Tổ chức không hợp lệ');
    return caller.tenantId;
  }

  @Get()
  list(
    @InternalCaller() caller: InternalServiceTokenClaims,
    @Query() query: DriverUsersQuery,
  ) {
    return this.users.list(this.tenant(caller), query);
  }

  @Get(':id/eligibility')
  eligible(
    @InternalCaller() caller: InternalServiceTokenClaims,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.users.eligible(this.tenant(caller), id);
  }

  @Post('resolve')
  resolve(
    @InternalCaller() caller: InternalServiceTokenClaims,
    @Body() dto: ResolveDriverUsersDto,
  ) {
    return this.users.resolve(this.tenant(caller), dto.userIds);
  }
}
