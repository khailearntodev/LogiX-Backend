import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { LogixConfigModule } from '@logix/config';
import { LogixLoggerModule } from '@logix/logger';
import { GlobalExceptionFilter } from '@logix/errors';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { DatabaseModule } from './database/database.module.js';
import { AuthModule } from './auth/auth.module.js';
import { auditConfigSchema } from './config/audit-config.schema.js';
import { AuditIngestionModule } from './ingestion/audit-ingestion.module.js';
import { AuditLogsModule } from './audit-logs/audit-logs.module.js';

@Module({
  imports: [
    // Configuration with Zod validation — fails fast if env vars missing
    LogixConfigModule.forRoot({
      schema: auditConfigSchema,
      envFilePath: ['apps/audit-service/.env', '.env'],
    }),

    // Structured Pino logging with correlation ID propagation
    LogixLoggerModule.forRoot({
      serviceName: 'audit-service',
    }),

    // Service-owned database
    DatabaseModule,

    // JWT authentication strategy for read-only audit queries
    AuthModule,

    // Multi-topic Kafka audit ingestion pipeline
    AuditIngestionModule,

    // Read-only audit trail query API
    AuditLogsModule,
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
