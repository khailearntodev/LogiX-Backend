import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Kafka } from 'kafkajs';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  KafkaEventConsumer,
  deliveryResultEventSchema,
} from '@logix/messaging';
import type { DomainEventEnvelope } from '@logix/messaging';
import { ServiceId } from '@logix/common';
import { ShipmentDeliveryEventsService } from '../src/shipments/shipment-delivery-events.service.js';
import { startIsolatedKafka } from '../../../libs/messaging/test/support/isolated-kafka.js';
import { startIsolatedFulfillmentDatabase } from './support/isolated-delivery-results.js';

const enabled = process.env.PHASE5_DELIVERY_RESULTS_E2E === '1';
const describeIsolated = enabled ? describe : describe.skip;

describeIsolated(
  'Delivery-result projection over isolated Kafka/PostgreSQL',
  () => {
    let database: Awaited<ReturnType<typeof startIsolatedFulfillmentDatabase>>;
    let broker: Awaited<ReturnType<typeof startIsolatedKafka>>;
    let prisma: PrismaService;
    let producer: ReturnType<Kafka['producer']>;
    let admin: ReturnType<Kafka['admin']>;
    let consumer: KafkaEventConsumer | undefined;
    let consumerService: ShipmentDeliveryEventsService | undefined;

    beforeAll(async () => {
      database = await startIsolatedFulfillmentDatabase();
      broker = await startIsolatedKafka();
      admin = broker.kafka.admin();
      await admin.connect();
      await admin.createTopics({
        waitForLeaders: true,
        topics: [
          { topic: broker.topic, numPartitions: 1, replicationFactor: 1 },
        ],
      });
      producer = broker.kafka.producer();
      await producer.connect();
      prisma = new PrismaService(
        new ConfigService({ DATABASE_URL: database.databaseUrl }),
      );
      await prisma.$connect();
    }, 180_000);

    afterAll(async () => {
      consumerService?.onModuleDestroy();
      if (consumer) await consumer.onModuleDestroy();
      if (producer) await producer.disconnect();
      if (admin) await admin.disconnect();
      if (prisma) await prisma.$disconnect();
      if (database) await database.dispose();
      if (broker) await broker.dispose();
    }, 30_000);

    async function shipment(tripId: string, status: string) {
      const tenantId = randomUUID();
      const row = await prisma.shipment.create({
        data: {
          tenantId,
          shipmentNumber: `QA-${randomUUID()}`,
          orderId: randomUUID(),
          warehouseId: randomUUID(),
          deliveryAddressId: randomUUID(),
          customerSnapshot: { customerId: randomUUID() },
          deliveryAddressSnapshot: { addressId: randomUUID() },
          warehouseSnapshot: { warehouseId: randomUUID() },
          orderNumber: `QA-ORDER-${randomUUID()}`,
          confirmedOrderVersion: 1n,
          status,
          totalWeight: '1.000',
          totalVolume: '0.100000',
          reservationGroupId: randomUUID(),
          assignedTripId: tripId,
        },
      });
      return row;
    }

    function deliveryEvent(options: {
      tenantId: string;
      shipmentId: string;
      tripId: string;
      stopId: string;
      eventType?: 'DeliveryCompleted' | 'DeliveryFailed';
      eventId?: string;
      actorId?: string;
    }): DomainEventEnvelope {
      const occurredAt = new Date().toISOString();
      const requestId = randomUUID();
      const eventType = options.eventType ?? 'DeliveryCompleted';
      return deliveryResultEventSchema.parse({
        eventId: options.eventId ?? randomUUID(),
        eventType,
        eventVersion: 2,
        occurredAt,
        tenantId: options.tenantId,
        actorId: options.actorId ?? randomUUID(),
        producer: ServiceId.TRANSPORT_SERVICE,
        correlationId: randomUUID(),
        causationId: requestId,
        aggregateType: 'DeliveryTrip',
        aggregateId: options.tripId,
        aggregateVersion: 2,
        payload: {
          contractVersion: 1,
          tenantId: options.tenantId,
          tripId: options.tripId,
          stopId: options.stopId,
          shipmentId: options.shipmentId,
          driverId: randomUUID(),
          assigneeUserId: randomUUID(),
          attempt: 1,
          outcome: eventType === 'DeliveryCompleted' ? 'DELIVERED' : 'FAILED',
          occurredAt,
          requestId,
          reason:
            eventType === 'DeliveryFailed' ? 'Recipient unavailable' : null,
        },
      });
    }

    async function publish(event: DomainEventEnvelope) {
      await producer.send({
        topic: broker.topic,
        messages: [{ key: event.aggregateId, value: JSON.stringify(event) }],
      });
    }

    async function eventually(
      eventId: string,
      expected: string,
      timeoutMs = 15_000,
    ) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const receipt = await prisma.inboxEvent.findFirst({
          where: {
            eventId,
            consumerName: 'fulfillment-delivery-results',
          },
        });
        if (receipt?.outcome === expected) return receipt;
        await new Promise((done) => setTimeout(done, 100));
      }
      throw new Error(
        `Timed out waiting for delivery result outcome ${expected}`,
      );
    }

    it('defers early results durably, recovers after consumer restart, deduplicates and serializes terminal races', async () => {
      const tripId = randomUUID();
      const stopId = randomUUID();
      const firstShipment = await shipment(tripId, 'READY_TO_SHIP');
      const event = deliveryEvent({
        tenantId: firstShipment.tenantId,
        shipmentId: firstShipment.id,
        tripId,
        stopId,
      });
      consumerService = new ShipmentDeliveryEventsService(prisma);
      consumer = new KafkaEventConsumer(
        broker.kafka,
        broker.topic,
        broker.groupId,
        (message) => consumerService!.handle(message),
      );
      await consumer.onModuleInit();
      await publish(event);
      await eventually(event.eventId, 'DEFERRED');

      consumerService.onModuleDestroy();
      await consumer.onModuleDestroy();
      consumer = undefined;
      consumerService = undefined;
      await prisma.shipment.update({
        where: { id: firstShipment.id },
        data: { status: 'DISPATCHED', version: { increment: 1 } },
      });

      const recoveredService = new ShipmentDeliveryEventsService(prisma);
      consumerService = recoveredService;
      consumer = new KafkaEventConsumer(
        broker.kafka,
        broker.topic,
        broker.groupId,
        (message) => recoveredService.handle(message),
      );
      recoveredService.onModuleInit();
      await consumer.onModuleInit();
      await eventually(event.eventId, 'APPLIED');
      expect(
        (
          await prisma.shipment.findUniqueOrThrow({
            where: { id: firstShipment.id },
          })
        ).status,
      ).toBe('DELIVERED');

      await publish(event);
      await eventually(event.eventId, 'APPLIED');
      const semanticDuplicate = {
        ...event,
        eventId: randomUUID(),
      };
      await publish(semanticDuplicate);
      await eventually(semanticDuplicate.eventId, 'DUPLICATE');
      const conflicting = {
        ...deliveryEvent({
          tenantId: firstShipment.tenantId,
          shipmentId: firstShipment.id,
          tripId,
          stopId,
          eventType: 'DeliveryFailed',
        }),
      };
      await publish(conflicting);
      await eventually(conflicting.eventId, 'CONFLICT');
      expect(
        await prisma.shipmentStatusHistory.count({
          where: {
            tenantId: firstShipment.tenantId,
            shipmentId: firstShipment.id,
          },
        }),
      ).toBe(1);
      expect(
        await prisma.outboxEvent.count({
          where: {
            tenantId: firstShipment.tenantId,
            aggregateId: firstShipment.id,
            eventType: 'ShipmentDelivered',
          },
        }),
      ).toBe(1);
    }, 60_000);

    it('serializes concurrent conflicting results for the same stop and records one terminal effect', async () => {
      const tripId = randomUUID();
      const stopId = randomUUID();
      const row = await shipment(tripId, 'DISPATCHED');
      const completed = deliveryEvent({
        tenantId: row.tenantId,
        shipmentId: row.id,
        tripId,
        stopId,
      });
      const failed = deliveryEvent({
        tenantId: row.tenantId,
        shipmentId: row.id,
        tripId,
        stopId,
        eventType: 'DeliveryFailed',
      });
      const serviceA = new ShipmentDeliveryEventsService(prisma);
      const serviceB = new ShipmentDeliveryEventsService(prisma);

      await Promise.all([serviceA.handle(completed), serviceB.handle(failed)]);

      const outcomes = await prisma.inboxEvent.findMany({
        where: {
          consumerName: 'fulfillment-delivery-results',
          semanticKey: `${tripId}:${stopId}`,
        },
        orderBy: { createdAt: 'asc' },
      });
      expect(outcomes.map((receipt) => receipt.outcome).sort()).toEqual([
        'APPLIED',
        'CONFLICT',
      ]);
      expect(
        await prisma.shipmentStatusHistory.count({
          where: { tenantId: row.tenantId, shipmentId: row.id },
        }),
      ).toBe(1);
      expect(
        await prisma.outboxEvent.count({
          where: { tenantId: row.tenantId, aggregateId: row.id },
        }),
      ).toBe(1);
    }, 60_000);
  },
);
