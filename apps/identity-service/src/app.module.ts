import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { LogixConfigModule } from '@logix/config';
import { LogixLoggerModule } from '@logix/logger';
import { GlobalExceptionFilter } from '@logix/errors';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { DatabaseModule } from './database/database.module.js';
import { AuthModule } from './auth/auth.module.js';
import { OrganizationsModule } from './organizations/organizations.module.js';
import { IamModule } from './iam/iam.module.js';
import { MailModule } from './mail/mail.module.js';
import { AdminModule } from './admin/admin.module.js';
import { DriverUsersModule } from './driver-users/driver-users.module.js';
import { IdentityMessagingModule } from './messaging/identity-messaging.module.js';
import { identityConfigSchema } from './config/identity-config.schema.js';
import { NotificationRecipientsModule } from './notification-recipients/notification-recipients.module.js';

@Module({
  imports: [
    // Configuration with Zod validation — fails fast if env vars missing
    LogixConfigModule.forRoot({
      schema: identityConfigSchema,
      envFilePath: ['apps/identity-service/.env', '.env'],
    }),

    // Structured Pino logging with correlation ID propagation
    LogixLoggerModule.forRoot({
      serviceName: 'identity-service',
    }),

    // Service-owned database
    DatabaseModule,
    IdentityMessagingModule,
    MailModule,
    AuthModule,
    OrganizationsModule,
    IamModule,
    AdminModule,
    DriverUsersModule,
    NotificationRecipientsModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Global exception filter for standardized error responses
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
  ],
})
export class AppModule {}
