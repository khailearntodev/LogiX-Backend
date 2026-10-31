import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { LogixConfigModule, databaseConfigSchema } from '@logix/config';
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
import { z } from 'zod';

@Module({
  imports: [
    // Configuration with Zod validation — fails fast if env vars missing
    LogixConfigModule.forRoot({
      schema: databaseConfigSchema.extend({
        INTERNAL_SERVICE_JWT_SECRET: z.string().min(32),
      }),
      envFilePath: ['apps/identity-service/.env', '.env'],
    }),

    // Structured Pino logging with correlation ID propagation
    LogixLoggerModule.forRoot({
      serviceName: 'identity-service',
    }),

    // Service-owned database
    DatabaseModule,
    MailModule,
    AuthModule,
    OrganizationsModule,
    IamModule,
    AdminModule,
    DriverUsersModule,
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
