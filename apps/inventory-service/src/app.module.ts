import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import {
  LogixConfigModule,
  databaseConfigSchema,
  kafkaConfigSchema,
  outboxConfigSchema,
  ConfigService,
} from '@logix/config';
import { LogixLoggerModule } from '@logix/logger';
import { GlobalExceptionFilter } from '@logix/errors';
import { DatabaseModule } from './database/database.module.js';
import { AuthModule } from './auth/auth.module.js';
import { InventoryModule } from './inventory/inventory.module.js';
import { z } from 'zod';
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
      schema: databaseConfigSchema
        .merge(kafkaConfigSchema)
        .merge(outboxConfigSchema)
        .extend({
          INTERNAL_SERVICE_JWT_SECRET: z.string().min(32),
          ORDER_SERVICE_URL: z.string().url(),
          RESERVATION_RECONCILE_AGE_MS: z.coerce.number().int().positive(),
          RESERVATION_RECONCILE_INTERVAL_MS: z.coerce.number().int().positive(),
          KAFKA_GROUP_ID: z.string().min(1),
          KAFKA_FULFILLMENT_TOPIC: z.string().min(1),
        }),
    }),

    // Structured Pino logging with correlation ID propagation
    LogixLoggerModule.forRoot({
      serviceName: 'inventory-service',
    }),

    // Service-owned database
    DatabaseModule,
    AuthModule,
    InventoryModule,
    MessagingModule.forRoot(),
  ],
  providers: [
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
            'inventory',
            ServiceId.INVENTORY_SERVICE,
            config.getOrThrow<number>('OUTBOX_TRANSACTION_TIMEOUT_MS'),
          ),
          producer,
          {
            topic: config.getOrThrow<string>('KAFKA_INVENTORY_TOPIC'),
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
