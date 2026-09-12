import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { generateId } from '@logix/common';
import { Kafka, Producer, type ProducerRecord } from 'kafkajs';
import type { CreateDomainEvent, DomainEventEnvelope } from './event-envelope.js';
import type { DomainEventMap, DomainEventType } from './interfaces/domain-event.interface.js';

/**
 * KafkaProducerService — High-level domain event producer.
 *
 * Wraps kafkajs Producer with:
 * - Auto-generated eventId and occurredAt timestamp
 * - Type-safe event publishing via DomainEventMap
 * - Partition key = aggregateId (preserves ordering per aggregate)
 * - JSON serialization
 *
 * @see docs/architecture/event-architecture.md §4 (Event ownership)
 * @see docs/architecture/event-architecture.md §6 (Ordering and versioning)
 */
@Injectable()
export class KafkaProducerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KafkaProducerService.name);
  private producer: Producer;

  constructor(private readonly kafka: Kafka) {
    this.producer = this.kafka.producer();
  }

  async onModuleInit(): Promise<void> {
    await this.producer.connect();
    this.logger.log('Kafka producer connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.producer.disconnect();
    this.logger.log('Kafka producer disconnected');
  }

  /**
   * Publish a type-safe domain event to Kafka.
   *
   * @param topic - Kafka topic to publish to
   * @param event - Event data (eventId and occurredAt are auto-generated)
   *
   * @example
   * await producer.publish('order-events', {
   *   eventType: 'OrderConfirmed',
   *   eventVersion: 1,
   *   producer: ServiceId.ORDER_SERVICE,
   *   tenantId: ctx.tenantId,
   *   actorId: ctx.actorId,
   *   correlationId: ctx.correlationId,
   *   causationId: ctx.causationId,
   *   aggregateType: 'SalesOrder',
   *   aggregateId: order.id,
   *   aggregateVersion: order.version,
   *   payload: { orderId: order.id, confirmedAt: new Date().toISOString() },
   * });
   */
  async publish<T extends DomainEventType>(
    topic: string,
    event: CreateDomainEvent<DomainEventMap[T]>,
  ): Promise<void> {
    const envelope: DomainEventEnvelope<DomainEventMap[T]> = {
      ...event,
      eventId: generateId(),
      occurredAt: new Date().toISOString(),
    };

    const record: ProducerRecord = {
      topic,
      messages: [
        {
          // Partition key = aggregateId to preserve per-aggregate ordering
          key: envelope.aggregateId,
          value: JSON.stringify(envelope),
          headers: {
            'event-type': envelope.eventType,
            'event-version': String(envelope.eventVersion),
            'tenant-id': envelope.tenantId,
            'correlation-id': envelope.correlationId,
          },
        },
      ],
    };

    await this.producer.send(record);

    this.logger.log({
      msg: 'Domain event published',
      eventType: envelope.eventType,
      eventId: envelope.eventId,
      aggregateType: envelope.aggregateType,
      aggregateId: envelope.aggregateId,
      topic,
    });
  }

  /**
   * Publish a raw domain event envelope (for advanced use cases).
   */
  async publishRaw(
    topic: string,
    envelope: DomainEventEnvelope,
  ): Promise<void> {
    const record: ProducerRecord = {
      topic,
      messages: [
        {
          key: envelope.aggregateId,
          value: JSON.stringify(envelope),
          headers: {
            'event-type': envelope.eventType,
            'event-version': String(envelope.eventVersion),
            'tenant-id': envelope.tenantId,
            'correlation-id': envelope.correlationId,
          },
        },
      ],
    };

    await this.producer.send(record);
  }
}
