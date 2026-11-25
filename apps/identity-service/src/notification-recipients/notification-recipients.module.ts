import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  INTERNAL_SERVICE_AUTH_OPTIONS,
  InternalServiceGuard,
} from '@logix/auth';
import { ServiceId } from '@logix/common';
import { NotificationRecipientsController } from './notification-recipients.controller.js';
import { NotificationRecipientsService } from './notification-recipients.service.js';

@Module({
  controllers: [NotificationRecipientsController],
  providers: [
    NotificationRecipientsService,
    InternalServiceGuard,
    {
      provide: INTERNAL_SERVICE_AUTH_OPTIONS,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('INTERNAL_SERVICE_JWT_SECRET'),
        serviceName: ServiceId.IDENTITY_SERVICE,
      }),
    },
  ],
})
export class NotificationRecipientsModule {}
