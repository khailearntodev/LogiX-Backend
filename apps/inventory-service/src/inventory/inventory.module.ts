import { Module } from '@nestjs/common';
import { ShipmentIssueService } from './services/shipment-issue.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { InventoryBalancesController } from './inventory-balances.controller.js';
import { StockMovementsController } from './stock-movements.controller.js';
import { StockReceiptsController } from './stock-receipts.controller.js';
import { InventoryBalanceService } from './services/inventory-balance.service.js';
import { StockMovementService } from './services/stock-movement.service.js';
import { StockReceiptService } from './services/stock-receipt.service.js';
import { ConfigService } from '@nestjs/config';
import {
  INTERNAL_SERVICE_AUTH_OPTIONS,
  InternalServiceGuard,
} from '@logix/auth';
import { ReservationService } from './services/reservation.service.js';
import { ReservationsInternalController } from './reservations.internal.controller.js';
import { ReservationOrderEventsService } from './services/reservation-order-events.service.js';
import { ReservationReconcilerService } from './services/reservation-reconciler.service.js';
import { KafkaEventConsumer } from '@logix/messaging';
import { Kafka } from 'kafkajs';

@Module({
  imports: [AuthModule],
  controllers: [
    InventoryBalancesController,
    StockMovementsController,
    StockReceiptsController,
    ReservationsInternalController,
  ],
  providers: [
    InventoryBalanceService,
    StockMovementService,
    StockReceiptService,
    ReservationService,
    ReservationOrderEventsService,
    ReservationReconcilerService,
    ShipmentIssueService,
    {
      provide: 'INVENTORY_SHIPMENT_CONSUMER', inject: [Kafka, ConfigService, ShipmentIssueService],
      useFactory: (kafka: Kafka, config: ConfigService, events: ShipmentIssueService) =>
        new KafkaEventConsumer(kafka, config.getOrThrow<string>('KAFKA_FULFILLMENT_TOPIC'),
          `${config.getOrThrow<string>('KAFKA_GROUP_ID')}.shipments`, event => events.handle(event)),
    },
    {
      provide: KafkaEventConsumer,
      inject: [Kafka, ConfigService, ReservationOrderEventsService],
      useFactory: (
        kafka: Kafka,
        config: ConfigService,
        events: ReservationOrderEventsService,
      ) =>
        new KafkaEventConsumer(
          kafka,
          config.getOrThrow<string>('KAFKA_ORDER_TOPIC'),
          config.getOrThrow<string>('KAFKA_GROUP_ID'),
          (event) => events.handle(event),
        ),
    },
    InternalServiceGuard,
    {
      provide: INTERNAL_SERVICE_AUTH_OPTIONS,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('INTERNAL_SERVICE_JWT_SECRET'),
        serviceName: 'inventory-service',
      }),
    },
  ],
  exports: [InventoryBalanceService, StockMovementService],
})
export class InventoryModule {}
