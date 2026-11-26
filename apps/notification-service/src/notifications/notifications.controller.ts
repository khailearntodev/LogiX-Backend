import {
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
import { CurrentUser, JwtAuthGuard, type AuthenticatedUser } from '@logix/auth';
import { ValidationError } from '@logix/errors';
import { ListNotificationsQueryDto } from './dto/list-notifications.dto.js';
import { NotificationInboxService } from './notification-inbox.service.js';

@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly inbox: NotificationInboxService) {}

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListNotificationsQueryDto,
  ) {
    return this.inbox.list(user, query);
  }

  @Get('unread-count')
  unreadCount(@CurrentUser() user: AuthenticatedUser) {
    return this.inbox.unreadCount(user);
  }

  @Patch(':id/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  async read(
    @CurrentUser() user: AuthenticatedUser,
    @Param(
      'id',
      new ParseUUIDPipe({
        exceptionFactory: () => new ValidationError('Mã thông báo không hợp lệ'),
      }),
    )
    notificationId: string,
  ): Promise<void> {
    await this.inbox.markRead(user, notificationId);
  }

  @Post('read-all')
  readAll(@CurrentUser() user: AuthenticatedUser) {
    return this.inbox.markAllRead(user);
  }

  @Patch(':id/archive')
  @HttpCode(HttpStatus.NO_CONTENT)
  async archive(
    @CurrentUser() user: AuthenticatedUser,
    @Param(
      'id',
      new ParseUUIDPipe({
        exceptionFactory: () => new ValidationError('Mã thông báo không hợp lệ'),
      }),
    )
    notificationId: string,
  ): Promise<void> {
    await this.inbox.archive(user, notificationId);
  }
}
