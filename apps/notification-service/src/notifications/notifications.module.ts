import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ChannelsModule } from '../channels/channels.module.js';
import { NotificationCoreService } from './notification-core.service.js';
import { NotificationsController } from './notifications.controller.js';
import { NotificationInboxService } from './notification-inbox.service.js';
import { NotificationWriterService } from './notification-writer.service.js';

@Module({
  imports: [AuthModule, ChannelsModule],
  controllers: [NotificationsController],
  providers: [
    NotificationCoreService,
    NotificationInboxService,
    NotificationWriterService,
  ],
  exports: [
    ChannelsModule,
    NotificationCoreService,
    NotificationInboxService,
    NotificationWriterService,
  ],
})
export class NotificationsModule {}
