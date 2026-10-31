import { Module } from '@nestjs/common';
import { OrderShipmentEventsService } from './services/order-shipment-events.service.js';
import { OrdersFulfillmentInternalController } from './orders-fulfillment.internal.controller.js';
import { AuthModule } from '../auth/auth.module.js';
import { MasterDataClient } from './integrations/master-data.client.js';
import { OrdersHealthController } from './orders-health.controller.js';
import { OrdersController } from './orders.controller.js';
import { OrderOutboxWriter } from './outbox/order-outbox.writer.js';
import { OrderCommandService } from './services/order-command.service.js';
import { OrderNumberService } from './services/order-number.service.js';
import { OrderQueryService } from './services/order-query.service.js';
import { OrderReferenceResolver } from './services/order-reference.resolver.js';
import { InventoryClient } from './integrations/inventory.client.js';
import { OrderReservationService } from './services/order-reservation.service.js';
import { OrderCancellationRecoveryService } from './services/order-cancellation-recovery.service.js';
import { OrderStockEventsService } from './services/order-stock-events.service.js';
import { ConfigService } from '@nestjs/config';
import { KafkaEventConsumer } from '@logix/messaging';
import { Kafka } from 'kafkajs';
import { OrdersInternalController } from './orders.internal.controller.js';
import { OrdersDispatchInternalController } from './orders-dispatch.internal.controller.js';
import { OrderDispatchService } from './services/order-dispatch.service.js';
import { OrderDispatchBatchService } from './services/order-dispatch-batch.service.js';
import {
  INTERNAL_SERVICE_AUTH_OPTIONS,
  InternalServiceGuard,
} from '@logix/auth';

@Module({
  imports: [AuthModule],
  // The health controller must stay first so `GET /orders/health` is matched before `GET /orders/:id`.
  controllers: [
    OrdersHealthController,
    OrdersController,
    OrdersInternalController,
    OrdersDispatchInternalController,
    OrdersFulfillmentInternalController,
  ],
  providers: [
    MasterDataClient,
    InventoryClient,
    OrderReservationService,
    OrderCancellationRecoveryService,
    OrderStockEventsService,
    OrderShipmentEventsService,
    {
      provide: 'ORDER_SHIPMENT_CONSUMER', inject: [Kafka, ConfigService, OrderShipmentEventsService],
      useFactory: (kafka: Kafka, config: ConfigService, events: OrderShipmentEventsService) =>
        new KafkaEventConsumer(kafka, config.getOrThrow<string>('KAFKA_FULFILLMENT_TOPIC'),
          `${config.getOrThrow<string>('KAFKA_GROUP_ID')}.shipments`, event => events.handle(event)),
    },
    InternalServiceGuard,
    {
      provide: INTERNAL_SERVICE_AUTH_OPTIONS,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('INTERNAL_SERVICE_JWT_SECRET'),
        serviceName: 'order-service',
      }),
    },
    {
      provide: KafkaEventConsumer,
      inject: [Kafka, ConfigService, OrderStockEventsService],
      useFactory: (
        kafka: Kafka,
        config: ConfigService,
        events: OrderStockEventsService,
      ) =>
        new KafkaEventConsumer(
          kafka,
          config.getOrThrow<string>('KAFKA_INVENTORY_TOPIC'),
          config.getOrThrow<string>('KAFKA_GROUP_ID'),
          (event) => events.handle(event),
        ),
    },
    {
      provide: 'ORDER_PENDING_STOCK_CONSUMER',
      inject: [Kafka, ConfigService, OrderStockEventsService],
      useFactory: (
        kafka: Kafka,
        config: ConfigService,
        events: OrderStockEventsService,
      ) =>
        new KafkaEventConsumer(
          kafka,
          config.getOrThrow<string>('KAFKA_ORDER_TOPIC'),
          `${config.getOrThrow<string>('KAFKA_GROUP_ID')}.pending`,
          (event) => events.handle(event),
        ),
    },
    OrderReferenceResolver,
    OrderNumberService,
    OrderOutboxWriter,
    OrderCommandService,
    OrderQueryService,
    OrderDispatchService,
    OrderDispatchBatchService,
  ],
})
export class OrdersModule {}
