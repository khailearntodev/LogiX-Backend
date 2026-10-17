import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { LogixConfigModule, ConfigService } from '@logix/config';
import { LogixLoggerModule } from '@logix/logger';
import { GlobalExceptionFilter } from '@logix/errors';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { DatabaseModule } from './database/database.module.js';
import { fulfillmentConfigSchema } from './config/fulfillment-config.schema.js';
import { ShipmentsModule } from './shipments/shipments.module.js';
import { ServiceId } from '@logix/common';
import {
  MessagingModule,
  OutboxRelay,
  PrismaOutboxStore,
  KafkaProducerService,
} from '@logix/messaging';
import { PrismaService } from './database/prisma.service.js';

@Module({
  imports: [
    // Configuration with Zod validation — fails fast if env vars missing
    LogixConfigModule.forRoot({
      schema: fulfillmentConfigSchema,
    }),

    // Structured Pino logging with correlation ID propagation
    LogixLoggerModule.forRoot({
      serviceName: 'fulfillment-service',
    }),

    // Service-owned database
    DatabaseModule,
    ShipmentsModule,
    MessagingModule.forRoot(),
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: OutboxRelay,
      inject: [PrismaService, ConfigService, KafkaProducerService],
      useFactory: (
        prisma: PrismaService,
        config: ConfigService,
        producer: KafkaProducerService,
      ) =>
        new OutboxRelay(
          new PrismaOutboxStore(
            prisma,
            'fulfillment',
            ServiceId.FULFILLMENT_SERVICE,
            config.getOrThrow<number>('OUTBOX_TRANSACTION_TIMEOUT_MS'),
          ),
          producer,
          {
            topic: config.getOrThrow<string>('KAFKA_FULFILLMENT_TOPIC'),
            intervalMs: config.getOrThrow<number>('OUTBOX_INTERVAL_MS'),
            batchSize: config.getOrThrow<number>('OUTBOX_BATCH_SIZE'),
            retryBaseMs: config.getOrThrow<number>('OUTBOX_RETRY_BASE_MS'),
            retryMaxMs: config.getOrThrow<number>('OUTBOX_RETRY_MAX_MS'),
          },
        ),
    },
    // Global exception filter for standardized error responses
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
  ],
})
export class AppModule {}
