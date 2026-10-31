import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { LogixConfigModule } from '@logix/config';
import { ConfigService } from '@nestjs/config';
import {
  InternalServiceGuard,
  INTERNAL_SERVICE_AUTH_OPTIONS,
} from '@logix/auth';
import { ServiceId } from '@logix/common';
import { transportConfigSchema } from './config/transport-config.schema.js';
import { DriverUsageController } from './drivers/driver-usage.controller.js';
import { DriverUsageService } from './drivers/driver-usage.service.js';
import { LogixLoggerModule } from '@logix/logger';
import { GlobalExceptionFilter } from '@logix/errors';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { DatabaseModule } from './database/database.module.js';
import { TripsModule } from './trips/trips.module.js';

@Module({
  imports: [
    // Configuration with Zod validation — fails fast if env vars missing
    LogixConfigModule.forRoot({
      schema: transportConfigSchema,
    }),

    // Structured Pino logging with correlation ID propagation
    LogixLoggerModule.forRoot({
      serviceName: 'transport-service',
    }),

    // Service-owned database
    DatabaseModule,
    TripsModule,
  ],
  controllers: [AppController, DriverUsageController],
  providers: [
    AppService,
    DriverUsageService,
    InternalServiceGuard,
    {
      provide: INTERNAL_SERVICE_AUTH_OPTIONS,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('INTERNAL_SERVICE_JWT_SECRET'),
        serviceName: ServiceId.TRANSPORT_SERVICE,
      }),
    },
    // Global exception filter for standardized error responses
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
  ],
})
export class AppModule {}
