import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { LogixConfigModule } from '@logix/config';
import { LogixLoggerModule } from '@logix/logger';
import { GlobalExceptionFilter } from '@logix/errors';
import { DeliveriesModule } from './deliveries/deliveries.module.js';
import { EventsModule } from './events/events.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { notificationConfigSchema } from './config/notification-config.schema.js';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { DatabaseModule } from './database/database.module.js';

@Module({
  imports: [
    // Configuration with Zod validation — fails fast if env vars missing
    LogixConfigModule.forRoot({
      schema: notificationConfigSchema,
    }),

    // Structured Pino logging with correlation ID propagation
    LogixLoggerModule.forRoot({
      serviceName: 'notification-service',
    }),

    // Service-owned database
    DatabaseModule,
    DeliveriesModule,
    EventsModule,
    NotificationsModule,
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
