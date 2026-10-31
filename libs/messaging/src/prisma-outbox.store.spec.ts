import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ServiceId } from "@logix/common";
import { deliveryResultEventSchema } from "./interfaces/transport.contract.js";
import {
  PrismaOutboxStore,
  type OutboxDatabase,
} from "./prisma-outbox.store.js";
import type { OutboxRelayRecord } from "./outbox-relay.js";

describe("PrismaOutboxStore", () => {
  it("keeps the real dispatch actor in the envelope without widening the strict v2 payload", async () => {
    const payload = { tripId: "trip", actorId: "actor" };
    const tx = {
      $queryRawUnsafe: vi.fn().mockResolvedValue([
        {
          id: "event",
          tenantId: "tenant",
          eventType: "TripDispatched",
          eventVersion: 2,
          aggregateType: "DeliveryTrip",
          aggregateId: "trip",
          aggregateVersion: 4n,
          correlationId: "request",
          causationId: "request",
          payload,
          occurredAt: new Date(),
          attemptCount: 0,
        },
      ]),
      $executeRawUnsafe: vi.fn(),
    };
    const database: OutboxDatabase = {
      $transaction: async (callback) => callback(tx),
    };
    const store = new PrismaOutboxStore(
      database,
      "transport",
      ServiceId.TRANSPORT_SERVICE,
      1000,
    );
    await store.withLockedBatch(1, async (records) => {
      expect(records[0].envelope.actorId).toBe("actor");
      expect(records[0].envelope.payload).toEqual({ tripId: "trip" });
    });
    expect(payload.actorId).toBe("actor");
  });
  it.each(["DeliveryCompleted", "DeliveryFailed"])(
    "keeps %s actor in the envelope and publishes the exact strict v2 payload",
    async (eventType) => {
      const tenantId = randomUUID();
      const tripId = randomUUID();
      const stopId = randomUUID();
      const shipmentId = randomUUID();
      const driverId = randomUUID();
      const assigneeUserId = randomUUID();
      const actorId = randomUUID();
      const requestId = randomUUID();
      const eventId = randomUUID();
      const occurredAt = "2026-10-26T12:00:00.000Z";
      const payload = {
        contractVersion: 1,
        tenantId,
        tripId,
        stopId,
        shipmentId,
        attempt: 1,
        driverId,
        assigneeUserId,
        outcome: eventType === "DeliveryCompleted" ? "DELIVERED" : "FAILED",
        occurredAt,
        reason: eventType === "DeliveryFailed" ? "Recipient unavailable" : null,
        requestId,
      };
      const tx = {
        $queryRawUnsafe: vi.fn().mockResolvedValue([
          {
            id: eventId,
            tenantId,
            eventType,
            eventVersion: 2,
            aggregateType: "DeliveryTrip",
            aggregateId: tripId,
            aggregateVersion: 4n,
            correlationId: requestId,
            causationId: requestId,
            payload,
            deliveryActorId: actorId,
            occurredAt: new Date(occurredAt),
            attemptCount: 0,
          },
        ]),
        $executeRawUnsafe: vi.fn(),
      };
      const database: OutboxDatabase = {
        $transaction: async (callback) => callback(tx),
      };
      const store = new PrismaOutboxStore(
        database,
        "transport",
        ServiceId.TRANSPORT_SERVICE,
        1000,
      );
      await store.withLockedBatch(1, async (records) => {
        expect(records[0].envelope.actorId).toBe(actorId);
        expect(records[0].envelope.payload).toEqual(payload);
        expect(Object.keys(records[0].envelope.payload as object)).toEqual(
          Object.keys(payload),
        );
        expect(
          deliveryResultEventSchema.parse(records[0].envelope).payload,
        ).toEqual(payload);
      });
      expect(tx.$queryRawUnsafe.mock.calls[0][0]).toContain(
        "transport.delivery_attempts",
      );
      expect(tx.$queryRawUnsafe.mock.calls[0][0]).toContain(
        "event.payload->>'requestId'",
      );
    },
  );
  it("accepts the Fulfillment schema without widening the schema whitelist", () => {
    const database: OutboxDatabase = { $transaction: vi.fn() };
    expect(
      () =>
        new PrismaOutboxStore(
          database,
          "fulfillment",
          ServiceId.FULFILLMENT_SERVICE,
          1000,
        ),
    ).not.toThrow();
  });
  it("accepts only the explicitly allowlisted Transport schema for RouteApproved relay", () => {
    const database: OutboxDatabase = { $transaction: vi.fn() };
    expect(
      () =>
        new PrismaOutboxStore(
          database,
          "transport",
          ServiceId.TRANSPORT_SERVICE,
          1000,
        ),
    ).not.toThrow();
    expect(() =>
      Reflect.construct(PrismaOutboxStore, [
        database,
        "transport; DROP SCHEMA transport",
        ServiceId.TRANSPORT_SERVICE,
        1000,
      ]),
    ).toThrow();
  });
  it("holds a SKIP LOCKED batch transaction through publishing and parameterizes writes", async () => {
    const tx = {
      $queryRawUnsafe: vi.fn().mockResolvedValue([
        {
          id: "event-1",
          tenantId: "tenant-1",
          eventType: "StockReserved",
          eventVersion: 1,
          aggregateType: "ReservationGroup",
          aggregateId: "group-1",
          aggregateVersion: 2n,
          correlationId: "correlation-1",
          causationId: null,
          payload: {},
          occurredAt: new Date("2026-10-11T00:00:00Z"),
          attemptCount: 0,
        },
      ]),
      $executeRawUnsafe: vi.fn().mockResolvedValue(1),
    };
    const transactionCalled = vi.fn();
    const database: OutboxDatabase = {
      $transaction: async (callback, options) => {
        transactionCalled(options);
        return callback(tx);
      },
    };
    const store = new PrismaOutboxStore(
      database,
      "inventory",
      ServiceId.INVENTORY_SERVICE,
      10000,
    );
    let received: OutboxRelayRecord[] = [];
    await store.withLockedBatch(5, async (records, transaction) => {
      received = records;
      await transaction.markPublished(records[0].id, new Date());
    });
    expect(tx.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining("FOR UPDATE OF event SKIP LOCKED"),
      5,
    );
    expect(tx.$queryRawUnsafe.mock.calls[0][0]).toContain("AND NOT EXISTS");
    expect(received[0].envelope.eventId).toBe("event-1");
    expect(received[0].envelope.aggregateVersion).toBe(2);
    expect(received[0].envelope.actorId).toBeNull();
    expect(tx.$executeRawUnsafe.mock.calls[0][1]).toBe("event-1");
    expect(transactionCalled).toHaveBeenCalledWith({ timeout: 10000 });
  });
});
