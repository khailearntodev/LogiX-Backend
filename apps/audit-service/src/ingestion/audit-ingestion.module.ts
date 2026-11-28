import { Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@logix/config';
import { KafkaEventConsumer, MessagingModule } from '@logix/messaging';
import { Kafka } from 'kafkajs';
import { AuditIngestionService } from './audit-ingestion.service.js';

const AUDIT_TOPIC_CONSUMERS = [
  { token: 'AUDIT_IDENTITY_CONSUMER', topicKey: 'KAFKA_IDENTITY_TOPIC', suffix: 'identity' },
  { token: 'AUDIT_INVENTORY_CONSUMER', topicKey: 'KAFKA_INVENTORY_TOPIC', suffix: 'inventory' },
  { token: 'AUDIT_ORDER_CONSUMER', topicKey: 'KAFKA_ORDER_TOPIC', suffix: 'order' },
  { token: 'AUDIT_FULFILLMENT_CONSUMER', topicKey: 'KAFKA_FULFILLMENT_TOPIC', suffix: 'fulfillment' },
  { token: 'AUDIT_TRANSPORT_CONSUMER', topicKey: 'KAFKA_TRANSPORT_TOPIC', suffix: 'transport' },
  { token: 'AUDIT_AGENT_CONSUMER', topicKey: 'KAFKA_AGENT_TOPIC', suffix: 'agent' },
] as const;

const consumerProviders: Provider[] = AUDIT_TOPIC_CONSUMERS.map(
  ({ token, topicKey, suffix }) => ({
    provide: token,
    inject: [Kafka, ConfigService, AuditIngestionService],
    useFactory: (
      kafka: Kafka,
      config: ConfigService,
      ingestion: AuditIngestionService,
    ) =>
      new KafkaEventConsumer(
        kafka,
        config.getOrThrow<string>(topicKey),
        `${config.getOrThrow<string>('KAFKA_GROUP_ID')}.${suffix}`,
        async (event) => {
          await ingestion.ingest(event);
        },
      ),
  }),
);

@Module({
  imports: [MessagingModule.forRoot({ enableProducer: false })],
  providers: [AuditIngestionService, ...consumerProviders],
  exports: [AuditIngestionService],
})
export class AuditIngestionModule {}
