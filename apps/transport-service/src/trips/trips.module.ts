import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KafkaEventConsumer, MessagingModule, KafkaProducerService, OutboxRelay, PrismaOutboxStore } from '@logix/messaging';
import { ServiceId } from '@logix/common';
import { PrismaService } from '../database/prisma.service.js';
import { RouteInputService } from '../routes/route-input.service.js';
import { RoutePlanService } from '../routes/route-plan.service.js';
import { RouteApprovalService } from '../routes/route-approval.service.js';
import { RoutePreviewTokenService } from '../routes/route-preview-token.service.js';
import { OptimizerClient } from '../routes/optimizer.client.js';
import { TripRouteController } from '../routes/trip-route.controller.js';
import { Kafka } from 'kafkajs';
import { AuthModule } from '../auth/auth.module.js';
import { FulfillmentClient } from '../integrations/fulfillment.client.js';
import { MasterDataClient } from '../integrations/master-data.client.js';
import { ShipmentCanceledConsumer } from './shipment-canceled.consumer.js';
import { TripCancellationService } from './trip-cancellation.service.js';
import { TripCancelPreviewTokenService } from './trip-cancel-preview-token.service.js';
import { TripCommandService } from './trip-command.service.js';
import { TripController } from './trip.controller.js';
import { TripMembershipService } from './trip-membership.service.js';
import { TripQueryService } from './trip-query.service.js';
import { TripRecoveryWorker } from './trip-recovery.worker.js';
import { TripDispatchService } from '../dispatch/trip-dispatch.service.js';
import { DriverTripController } from '../driver/driver-trip.controller.js';
import { DriverTripService } from '../driver/driver-trip.service.js';
import { DriverActionPreviewTokenService } from '../driver/driver-action-preview-token.service.js';

@Module({
  imports: [AuthModule, MessagingModule.forRoot()],
  controllers: [TripController, TripRouteController, DriverTripController],
  providers: [
    MasterDataClient,
    FulfillmentClient,
    TripQueryService,
    TripCommandService,
    TripMembershipService,
    TripCancellationService,
    TripCancelPreviewTokenService,
    TripRecoveryWorker,
    TripDispatchService,
    DriverTripService,
    DriverActionPreviewTokenService,
    ShipmentCanceledConsumer,
    RouteInputService,
    RoutePlanService,
    RouteApprovalService,
    RoutePreviewTokenService,
    OptimizerClient,
    {
      provide: OutboxRelay,
      inject: [PrismaService, ConfigService, KafkaProducerService],
      useFactory: (prisma: PrismaService, config: ConfigService, producer: KafkaProducerService) =>
        new OutboxRelay(new PrismaOutboxStore(prisma, 'transport', ServiceId.TRANSPORT_SERVICE,
          config.getOrThrow<number>('OUTBOX_TRANSACTION_TIMEOUT_MS')), producer, {
          topic: config.getOrThrow<string>('KAFKA_TRANSPORT_TOPIC'),
          intervalMs: config.getOrThrow<number>('OUTBOX_INTERVAL_MS'),
          batchSize: config.getOrThrow<number>('OUTBOX_BATCH_SIZE'),
          retryBaseMs: config.getOrThrow<number>('OUTBOX_RETRY_BASE_MS'),
          retryMaxMs: config.getOrThrow<number>('OUTBOX_RETRY_MAX_MS'),
        }),
    },
    {
      provide: 'TRANSPORT_SHIPMENT_CANCELED_CONSUMER',
      inject: [Kafka, ConfigService, ShipmentCanceledConsumer],
      useFactory: (
        kafka: Kafka,
        config: ConfigService,
        handler: ShipmentCanceledConsumer,
      ) =>
        new KafkaEventConsumer(
          kafka,
          config.getOrThrow<string>('KAFKA_FULFILLMENT_TOPIC'),
          `${config.getOrThrow<string>('KAFKA_GROUP_ID')}.transport.shipment-canceled`,
          (event) => handler.handle(event),
        ),
    },
  ],
})
export class TripsModule {}
