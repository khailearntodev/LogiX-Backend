import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KafkaEventConsumer, MessagingModule } from '@logix/messaging';
import { Kafka } from 'kafkajs';
import { DeliveriesModule } from '../deliveries/deliveries.module.js';
import { IntegrationsModule } from '../integrations/integrations.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { NotificationProcessor } from './notification-processor.js';

/**
 * Kafka wiring boundary for the first implementation slice.
 * Each topic has an independent group suffix so order and transport partitions
 * can scale independently while sharing the service-level processing boundary.
 */
@Module({
  imports: [
    MessagingModule.forRoot({ enableProducer: false }),
    DeliveriesModule,
    IntegrationsModule,
    NotificationsModule,
  ],
  providers: [
    NotificationProcessor,
    {
      provide: 'NOTIFICATION_ORDER_EVENTS_CONSUMER',
      inject: [Kafka, ConfigService, NotificationProcessor],
      useFactory: (kafka: Kafka, config: ConfigService, processor: NotificationProcessor) =>
        new KafkaEventConsumer(
          kafka,
          config.getOrThrow<string>('KAFKA_ORDER_TOPIC'),
          `${config.getOrThrow<string>('KAFKA_GROUP_ID')}.notification.order-events`,
          (event) => processor.handle(event).then(() => undefined),
        ),
    },
    {
      provide: 'NOTIFICATION_TRANSPORT_EVENTS_CONSUMER',
      inject: [Kafka, ConfigService, NotificationProcessor],
      useFactory: (kafka: Kafka, config: ConfigService, processor: NotificationProcessor) =>
        new KafkaEventConsumer(
          kafka,
          config.getOrThrow<string>('KAFKA_TRANSPORT_TOPIC'),
          `${config.getOrThrow<string>('KAFKA_GROUP_ID')}.notification.transport-events`,
          (event) => processor.handle(event).then(() => undefined),
        ),
    },
  ],
})
export class EventsModule {}
