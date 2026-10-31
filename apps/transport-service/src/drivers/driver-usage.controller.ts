import {
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
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
import { DriverUsageService } from './driver-usage.service.js';

@Controller('internal/drivers')
@UseGuards(InternalServiceGuard)
@AllowInternalCallers(ServiceId.MASTER_DATA_SERVICE)
export class DriverUsageController {
  constructor(
    @Inject(DriverUsageService) private readonly drivers: DriverUsageService,
  ) {}

  @Get(':id/usage')
  usage(
    @InternalCaller() caller: InternalServiceTokenClaims,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    if (!isUUID(caller.tenantId))
      throw new UnauthorizedException('Tổ chức không hợp lệ');
    return this.drivers.usage(caller.tenantId, id);
  }
}
