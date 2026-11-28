import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import {
  AllowInternalCallers,
  InternalCaller,
  InternalServiceGuard,
  type InternalServiceTokenClaims,
} from '@logix/auth';
import { ServiceId } from '@logix/common';
import { isUUID } from 'class-validator';
import { UnauthorizedException } from '@nestjs/common';
import { ResolveNotificationRecipientsDto } from './notification-recipients.dto.js';
import { NotificationRecipientsService } from './notification-recipients.service.js';

@Controller('internal/recipients')
@UseGuards(InternalServiceGuard)
@AllowInternalCallers(ServiceId.NOTIFICATION_SERVICE)
export class NotificationRecipientsController {
  constructor(private readonly recipients: NotificationRecipientsService) {}

  @Post('resolve')
  resolve(
    @InternalCaller() caller: InternalServiceTokenClaims,
    @Body() dto: ResolveNotificationRecipientsDto,
  ) {
    if (!isUUID(caller.tenantId)) {
      throw new UnauthorizedException('Tổ chức không hợp lệ');
    }
    return this.recipients.resolve(caller.tenantId, dto);
  }
}
