import {
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import type { Consumer, Kafka } from "kafkajs";
import type { DomainEventEnvelope } from "./event-envelope.js";

const CONSUMER_SESSION_TIMEOUT_MS = 180_000;

export class DomainEventProcessingError extends Error {
  readonly retriable = true;

  constructor(cause: unknown) {
    super("Domain event processing failed; offset must remain retryable", {
      cause,
    });
    this.name = "DomainEventProcessingError";
  }
}

export function parseEventEnvelope(value: string): DomainEventEnvelope {
  const parsed: unknown = JSON.parse(value);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("eventId" in parsed) ||
    typeof parsed.eventId !== "string" ||
    !("tenantId" in parsed) ||
    typeof parsed.tenantId !== "string" ||
    !("correlationId" in parsed) ||
    typeof parsed.correlationId !== "string" ||
    !("eventType" in parsed) ||
    typeof parsed.eventType !== "string" ||
    !("eventVersion" in parsed) ||
    (parsed.eventVersion !== 1 &&
      !(
        [
          "RouteApproved",
          "TripDispatched",
          "DeliveryCompleted",
          "DeliveryFailed",
        ].includes(parsed.eventType) && parsed.eventVersion === 2
      )) ||
    !("aggregateVersion" in parsed) ||
    !Number.isSafeInteger(parsed.aggregateVersion) ||
    !("payload" in parsed) ||
    !("producer" in parsed) ||
    typeof parsed.producer !== "string" ||
    !("aggregateId" in parsed) ||
    typeof parsed.aggregateId !== "string" ||
    !("aggregateType" in parsed) ||
    typeof parsed.aggregateType !== "string" ||
    !("occurredAt" in parsed) ||
    typeof parsed.occurredAt !== "string" ||
    !("causationId" in parsed) ||
    typeof parsed.causationId !== "string" ||
    !("actorId" in parsed) ||
    (parsed.actorId !== null && typeof parsed.actorId !== "string")
  ) {
    throw new Error("Invalid domain event envelope");
  }
  return parsed as DomainEventEnvelope;
}

export class KafkaEventConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KafkaEventConsumer.name);
  private readonly consumer: Consumer;

  constructor(
    kafka: Kafka,
    private readonly topic: string,
    groupId: string,
    private readonly handler: (event: DomainEventEnvelope) => Promise<void>,
  ) {
    if (!topic.trim() || !groupId.trim())
      throw new Error("Consumer topic and group are required");
    this.consumer = kafka.consumer({
      groupId,
      sessionTimeout: CONSUMER_SESSION_TIMEOUT_MS,
      retry: {
        restartOnFailure: async (error) => {
          this.logger.error(
            error,
            "Domain consumer failed; restarting without advancing failed offset",
          );
          return true;
        },
      },
    });
  }

  async onModuleInit(): Promise<void> {
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: this.topic, fromBeginning: true });
    await this.consumer.run({
      eachMessage: async ({ message }) => {
        let event: DomainEventEnvelope | undefined;
        try {
          if (!message.value) throw new Error("Domain event has no payload");
          event = parseEventEnvelope(message.value.toString());
          await this.handler(event);
        } catch (error) {
          this.logger.error({
            eventId: event?.eventId,
            tenantId: event?.tenantId,
            correlationId: event?.correlationId,
            error:
              error instanceof Error
                ? error.message
                : "Domain event processing failed",
          });
          throw new DomainEventProcessingError(error);
        }
      },
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.consumer.stop();
    await this.consumer.disconnect();
  }
}
