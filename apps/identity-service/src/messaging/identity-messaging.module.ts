import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@logix/config';
import { ServiceId } from '@logix/common';
import {
  KafkaProducerService,
  MessagingModule,
  OutboxRelay,
  PrismaOutboxStore,
  type OutboxDatabase,
} from '@logix/messaging';
import { PrismaService } from '../database/prisma.service.js';
import { IdentityAuditOutboxWriter } from './identity-audit-outbox.writer.js';

@Global()
@Module({
  imports: [MessagingModule.forRoot()],
  providers: [
    IdentityAuditOutboxWriter,
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
            prisma as unknown as OutboxDatabase,
            'identity',
            ServiceId.IDENTITY_SERVICE,
            config.getOrThrow<number>('OUTBOX_TRANSACTION_TIMEOUT_MS'),
          ),
          producer,
          {
            topic: config.getOrThrow<string>('KAFKA_IDENTITY_TOPIC'),
            intervalMs: config.getOrThrow<number>('OUTBOX_INTERVAL_MS'),
            batchSize: config.getOrThrow<number>('OUTBOX_BATCH_SIZE'),
            retryBaseMs: config.getOrThrow<number>('OUTBOX_RETRY_BASE_MS'),
            retryMaxMs: config.getOrThrow<number>('OUTBOX_RETRY_MAX_MS'),
          },
        ),
    },
  ],
  exports: [IdentityAuditOutboxWriter],
})
export class IdentityMessagingModule { }
