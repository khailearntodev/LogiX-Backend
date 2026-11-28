import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ServiceId } from '@logix/common';
import {
  ClaimLeaseOutboxRelay,
  KafkaProducerService,
  PrismaClaimLeaseOutboxStore,
} from '@logix/messaging';
import { PrismaService } from '../database/prisma.service.js';

@Injectable()
export class NotificationOutboxRelayService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly enabled: boolean;
  private readonly relay: ClaimLeaseOutboxRelay;

  constructor(
    prisma: PrismaService,
    producer: KafkaProducerService,
    config: ConfigService,
  ) {
    this.enabled = config.getOrThrow<boolean>('OUTBOX_RELAY_ENABLED');
    const txTimeoutMs = config.getOrThrow<number>('OUTBOX_TX_TIMEOUT_MS');

    this.relay = new ClaimLeaseOutboxRelay(
      new PrismaClaimLeaseOutboxStore(
        prisma,
        'notification',
        ServiceId.NOTIFICATION_SERVICE,
        txTimeoutMs,
      ),
      producer,
      {
        defaultTopic: config.getOrThrow<string>(
          'KAFKA_NOTIFICATION_BROADCAST_TOPIC',
        ),
        intervalMs: config.getOrThrow<number>('OUTBOX_INTERVAL_MS'),
        batchSize: config.getOrThrow<number>('OUTBOX_BATCH_SIZE'),
        leaseMs: config.getOrThrow<number>('OUTBOX_LEASE_MS'),
        publishTimeoutMs: config.getOrThrow<number>('OUTBOX_PUBLISH_TIMEOUT_MS'),
        retryBaseMs: config.getOrThrow<number>('OUTBOX_RETRY_BASE_MS'),
        retryMaxMs: config.getOrThrow<number>('OUTBOX_RETRY_MAX_MS'),
      },
    );
  }

  onModuleInit(): void {
    if (this.enabled) {
      this.relay.onModuleInit();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.relay.onModuleDestroy();
  }

  flush(): Promise<number> {
    return this.relay.flush();
  }
}
