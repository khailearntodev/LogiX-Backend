import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kafka } from 'kafkajs';
import { KafkaEventConsumer } from '@logix/messaging';
import { AuthModule } from '../auth/auth.module.js';
import { ShipmentsController } from './shipments.controller.js';
import { OrderClient } from './order.client.js';
import { ShipmentQueryService } from './shipment-query.service.js';
import { ShipmentCommandService } from './shipment-command.service.js';
import { ShipmentDispatchService } from './shipment-dispatch.service.js';
import { ShipmentOrderEventsService } from './shipment-order-events.service.js';
import { ShipmentRecoveryService } from './shipment-recovery.service.js';

@Module({
  imports: [AuthModule],
  controllers: [ShipmentsController],
  providers: [
    OrderClient,
    ShipmentQueryService,
    ShipmentCommandService,
    ShipmentDispatchService,
    ShipmentRecoveryService,
    ShipmentOrderEventsService,
    {
      provide: KafkaEventConsumer,
      inject: [Kafka, ConfigService, ShipmentOrderEventsService],
      useFactory: (
        kafka: Kafka,
        config: ConfigService,
        events: ShipmentOrderEventsService,
      ) =>
        new KafkaEventConsumer(
          kafka,
          config.getOrThrow<string>('KAFKA_ORDER_TOPIC'),
          config.getOrThrow<string>('KAFKA_GROUP_ID'),
          (event) => events.handle(event),
        ),
    },
  ],
})
export class ShipmentsModule {}
