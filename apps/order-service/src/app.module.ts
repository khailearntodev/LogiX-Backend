import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { LogixConfigModule, ConfigService } from '@logix/config';
import { LogixLoggerModule } from '@logix/logger';
import { GlobalExceptionFilter } from '@logix/errors';
import { orderConfigSchema } from './config/order-config.schema.js';
import { DatabaseModule } from './database/database.module.js';
import { OrdersModule } from './orders/orders.module.js';
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
      schema: orderConfigSchema,
    }),

    // Structured Pino logging with correlation ID propagation
    LogixLoggerModule.forRoot({
      serviceName: 'order-service',
    }),

    // Service-owned database
    DatabaseModule,

    OrdersModule,
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
            'orders',
            ServiceId.ORDER_SERVICE,
            config.getOrThrow<number>('OUTBOX_TRANSACTION_TIMEOUT_MS'),
          ),
          producer,
          {
            topic: config.getOrThrow<string>('KAFKA_ORDER_TOPIC'),
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
