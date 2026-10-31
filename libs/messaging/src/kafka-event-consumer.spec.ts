import { describe, expect, it } from "vitest";
import {
  DomainEventProcessingError,
  parseEventEnvelope,
} from "./kafka-event-consumer.js";

const envelope = {
  eventId: "event",
  tenantId: "tenant",
  eventType: "StockReceived",
  eventVersion: 1,
  aggregateId: "aggregate",
  aggregateType: "StockMovement",
  aggregateVersion: 1,
  occurredAt: new Date().toISOString(),
  actorId: null,
  causationId: "cause",
  correlationId: "correlation",
  producer: "inventory-service",
  payload: {},
};

describe("parseEventEnvelope", () => {
  it("accepts system events with null actor and preserves identity", () => {
    expect(parseEventEnvelope(JSON.stringify(envelope))).toEqual(envelope);
  });

  it.each([
    null,
    {},
    { ...envelope, eventVersion: 0 },
    { ...envelope, eventVersion: 1.5 },
    { ...envelope, eventVersion: 2 },
    { ...envelope, eventType: "RouteApproved", eventVersion: 3 },
    { ...envelope, aggregateVersion: 1.5 },
    { ...envelope, actorId: 42 },
    { ...envelope, tenantId: null },
  ])("rejects invalid envelope %j", (event) => {
    expect(() => parseEventEnvelope(JSON.stringify(event))).toThrow(
      "Invalid domain event envelope",
    );
  });

  it("rejects invalid JSON", () => {
    expect(() => parseEventEnvelope("invalid-json")).toThrow();
  });
  it("parses RouteApproved v2 while preserving event version for owner payload handling", () => {
    expect(
      parseEventEnvelope(
        JSON.stringify({
          ...envelope,
          eventType: "RouteApproved",
          eventVersion: 2,
        }),
      ).eventVersion,
    ).toBe(2);
  });
  it("accepts the coordinated TripDispatched v2 protocol, not arbitrary future versions", () => {
    expect(
      parseEventEnvelope(
        JSON.stringify({
          ...envelope,
          eventType: "TripDispatched",
          eventVersion: 2,
        }),
      ).eventVersion,
    ).toBe(2);
    expect(() =>
      parseEventEnvelope(
        JSON.stringify({
          ...envelope,
          eventType: "TripDispatched",
          eventVersion: 3,
        }),
      ),
    ).toThrow();
  });
  it.each(["DeliveryCompleted", "DeliveryFailed"])(
    "accepts %s v2 and rejects uncoordinated versions",
    (eventType) => {
      expect(
        parseEventEnvelope(
          JSON.stringify({ ...envelope, eventType, eventVersion: 2 }),
        ).eventVersion,
      ).toBe(2);
      expect(() =>
        parseEventEnvelope(
          JSON.stringify({ ...envelope, eventType, eventVersion: 3 }),
        ),
      ).toThrow("Invalid domain event envelope");
    },
  );
  it("marks handler failures retriable for KafkaJS consumer recovery", () => {
    const cause = new Error("Inventory unavailable");
    const error = new DomainEventProcessingError(cause);
    expect(error.retriable).toBe(true);
    expect(error.cause).toBe(cause);
  });
});
