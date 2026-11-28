import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service.js';
import { NotificationCoreService } from '../notifications/notification-core.service.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { InAppDeliveryWorker } from './in-app-delivery.worker.js';
import { PrismaDeliveryStore } from './prisma-delivery.store.js';

@Module({
  imports: [NotificationsModule],
  providers: [
    {
      provide: PrismaDeliveryStore,
      inject: [PrismaService, ConfigService],
      useFactory: (prisma: PrismaService, config: ConfigService) =>
        new PrismaDeliveryStore(
          prisma,
          config.getOrThrow<number>('DELIVERY_TX_TIMEOUT_MS'),
        ),
    },
    {
      provide: InAppDeliveryWorker,
      inject: [PrismaDeliveryStore, NotificationCoreService, ConfigService],
      useFactory: (
        store: PrismaDeliveryStore,
        core: NotificationCoreService,
        config: ConfigService,
      ) =>
        new InAppDeliveryWorker(store, core, {
          enabled: config.getOrThrow<boolean>('DELIVERY_WORKER_ENABLED'),
          pollIntervalMs: config.getOrThrow<number>('DELIVERY_POLL_INTERVAL_MS'),
          batchSize: config.getOrThrow<number>('DELIVERY_BATCH_SIZE'),
          concurrency: config.getOrThrow<number>('DELIVERY_CONCURRENCY'),
          leaseMs: config.getOrThrow<number>('DELIVERY_LEASE_MS'),
          maxAttempts: config.getOrThrow<number>('DELIVERY_MAX_ATTEMPTS'),
          retryBaseMs: config.getOrThrow<number>('DELIVERY_RETRY_BASE_MS'),
          retryMaxMs: config.getOrThrow<number>('DELIVERY_RETRY_MAX_MS'),
          reclaimIntervalMs: config.getOrThrow<number>(
            'DELIVERY_RECLAIM_INTERVAL_MS',
          ),
        }),
    },
  ],
  exports: [PrismaDeliveryStore, InAppDeliveryWorker],
})
export class DeliveriesModule {}
