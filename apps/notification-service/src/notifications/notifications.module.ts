import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ChannelsModule } from '../channels/channels.module.js';
import { NotificationCoreService } from './notification-core.service.js';

@Module({
  imports: [AuthModule, ChannelsModule],
  providers: [NotificationCoreService],
  exports: [ChannelsModule, NotificationCoreService],
})
export class NotificationsModule {}
