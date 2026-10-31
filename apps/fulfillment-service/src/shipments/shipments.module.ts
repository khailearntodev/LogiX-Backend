import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kafka } from 'kafkajs';
import { KafkaEventConsumer } from '@logix/messaging';
import {
  InternalServiceGuard,
  INTERNAL_SERVICE_AUTH_OPTIONS,
  type InternalServiceAuthOptions,
} from '@logix/auth';
import { ServiceId } from '@logix/common';
import { AuthModule } from '../auth/auth.module.js';
import { ShipmentsController } from './shipments.controller.js';
import { InternalShipmentTripController } from './internal-shipment-trip.controller.js';
import { OrderClient } from './order.client.js';
import { ShipmentQueryService } from './shipment-query.service.js';
import { ShipmentCommandService } from './shipment-command.service.js';
import { ShipmentDispatchService } from './shipment-dispatch.service.js';
import { ShipmentOrderEventsService } from './shipment-order-events.service.js';
import { ShipmentRecoveryService } from './shipment-recovery.service.js';
import { ShipmentDeliveryEventsService } from './shipment-delivery-events.service.js';
import { ShipmentPoolService } from './shipment-pool.service.js';
import { ShipmentTripClaimService } from './shipment-trip-claim.service.js';
import { ShipmentDispatchBatchService } from './shipment-dispatch-batch.service.js';

@Module({
  imports: [AuthModule],
  controllers: [ShipmentsController, InternalShipmentTripController],
  providers: [
    InternalServiceGuard,
    {
      provide: INTERNAL_SERVICE_AUTH_OPTIONS,
      inject: [ConfigService],
      useFactory: (config: ConfigService): InternalServiceAuthOptions => ({
        secret: config.getOrThrow<string>('INTERNAL_SERVICE_JWT_SECRET'),
        serviceName: ServiceId.FULFILLMENT_SERVICE,
      }),
    },
    OrderClient,
    ShipmentQueryService,
    ShipmentCommandService,
    ShipmentDispatchService,
    ShipmentDispatchBatchService,
    ShipmentPoolService,
    ShipmentTripClaimService,
    ShipmentRecoveryService,
    ShipmentOrderEventsService,
    ShipmentDeliveryEventsService,
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
    {
      provide: 'DELIVERY_RESULTS_KAFKA_CONSUMER',
      inject: [Kafka, ConfigService, ShipmentDeliveryEventsService],
      useFactory: (
        kafka: Kafka,
        config: ConfigService,
        events: ShipmentDeliveryEventsService,
      ) =>
        new KafkaEventConsumer(
          kafka,
          config.getOrThrow<string>('KAFKA_FULFILLMENT_TOPIC'),
          `${config.getOrThrow<string>('KAFKA_GROUP_ID')}-delivery-results`,
          (event) => events.handle(event),
        ),
    },
  ],
})
export class ShipmentsModule {}
