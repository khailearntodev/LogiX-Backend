import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KafkaEventConsumer } from '@logix/messaging';
import { Kafka } from 'kafkajs';
import { AuthModule } from '../auth/auth.module.js';
import { DeliveriesModule } from '../deliveries/deliveries.module.js';
import { IntegrationsModule } from '../integrations/integrations.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { AdminBroadcastsController } from './admin-broadcasts.controller.js';
import { BroadcastCommandService } from './broadcast-command.service.js';
import { BroadcastFanoutWorker } from './broadcast-fanout.worker.js';
import { BroadcastQueryService } from './broadcast-query.service.js';
import { BroadcastReconcilerService } from './broadcast-reconciler.service.js';
import { NotificationOutboxRelayService } from './notification-outbox-relay.service.js';

@Module({
  imports: [AuthModule, DeliveriesModule, IntegrationsModule, NotificationsModule],
  controllers: [AdminBroadcastsController],
  providers: [
    BroadcastCommandService,
    BroadcastQueryService,
    BroadcastFanoutWorker,
    BroadcastReconcilerService,
    NotificationOutboxRelayService,
    {
      provide: 'NOTIFICATION_BROADCAST_COMMANDS_CONSUMER',
      inject: [Kafka, ConfigService, BroadcastFanoutWorker],
      useFactory: (
        kafka: Kafka,
        config: ConfigService,
        worker: BroadcastFanoutWorker,
      ) =>
        new KafkaEventConsumer(
          kafka,
          config.getOrThrow<string>('KAFKA_NOTIFICATION_BROADCAST_TOPIC'),
          `${config.getOrThrow<string>('KAFKA_GROUP_ID')}.notification.broadcast-fanout`,
          (event) => worker.handle(event).then(() => undefined),
        ),
    },
  ],
  exports: [
    BroadcastCommandService,
    BroadcastQueryService,
    BroadcastFanoutWorker,
    BroadcastReconcilerService,
    NotificationOutboxRelayService,
  ],
})
export class BroadcastsModule {}
