import {
  Body,
  Controller,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  HttpCode,
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
import { DriverLinkService } from './driver-link.service.js';
import { DriverLinkLockDto } from './dto/driver.dto.js';

@Controller('internal/drivers')
@UseGuards(InternalServiceGuard)
@AllowInternalCallers(ServiceId.TRANSPORT_SERVICE)
export class InternalDriverLinksController {
  constructor(
    @Inject(DriverLinkService) private readonly links: DriverLinkService,
  ) {}

  @Post(':id/link-lock')
  @HttpCode(200)
  lock(
    @InternalCaller() caller: InternalServiceTokenClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DriverLinkLockDto,
  ) {
    if (!isUUID(caller.tenantId))
      throw new UnauthorizedException('Tổ chức không hợp lệ');
    return this.links.lockBinding(caller.tenantId, id, dto);
  }
}
