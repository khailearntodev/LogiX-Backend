import { describe, expect, it } from 'vitest';
import {
  actionPreviewBindingSchema,
  actionConfirmationSchema,
  assertShipmentClaimReceiptBinding,
  assertShipmentReleaseReceiptBinding,
  assertBatchDispatchGrantBinding,
  assertOptimizerRunBinding,
  assertPreviewActorBinding,
  assertPreviewNotExpired,
  batchDispatchGrantDecisionSchema,
  batchDispatchGrantRequestSchema,
  decimal18_3Schema,
  decimal18_6Schema,
  deferredDeliveryResultSchema,
  deliveryResultEventSchema,
  optimizerRequestBindingSchema,
  optimizerRunReceiptSchema,
  shipmentClaimRequestSchema,
  shipmentClaimReceiptSchema,
  shipmentPoolQuerySchema,
  shipmentReleaseRequestSchema,
  shipmentReleaseReceiptSchema,
  tripDispatchedEventV2Schema,
  transportVersionSchema,
} from './transport.contract.js';

const id1 = '2cfd1d52-605e-4bab-b088-fdd03f7e3401';
const id2 = '6fb3b6c5-042f-4f6b-a7d4-254c25ad1938';
const id3 = '4e6768f3-c541-4adb-9f26-ff9fdb432b8b';
const hash = 'a'.repeat(64);
const timestamp = '2026-10-25T07:00:00.000Z';

describe('transport runtime contracts', () => {
  it('accepts positive UUIDs, positive safe versions and storage Decimal strings', () => {
    expect(shipmentClaimRequestSchema.parse({
      contractVersion: 1,
      tenantId: id1,
      requestId: id2,
      tripId: id3,
      shipmentId: id1,
      actorId: id2,
      expectedTripVersion: 1,
      expectedShipmentVersion: Number.MAX_SAFE_INTEGER,
    })).toMatchObject({ contractVersion: 1, expectedTripVersion: 1 });
    expect(transportVersionSchema.safeParse(Number.MAX_SAFE_INTEGER).success).toBe(true);
    expect(decimal18_3Schema.safeParse('123456789012345.123').success).toBe(true);
    expect(decimal18_6Schema.safeParse('123456789012.123456').success).toBe(true);
  });

  it('rejects malformed UUIDs, non-positive/unsafe versions and invalid Decimals', () => {
    expect(shipmentClaimRequestSchema.safeParse({
      contractVersion: 1,
      tenantId: 'tenant-1',
      requestId: id2,
      tripId: id3,
      shipmentId: id1,
      actorId: id2,
      expectedTripVersion: 0,
      expectedShipmentVersion: Number.MAX_SAFE_INTEGER + 1,
    }).success).toBe(false);
    expect(transportVersionSchema.safeParse(-1).success).toBe(false);
    expect(decimal18_3Schema.safeParse('1.2345').success).toBe(false);
    expect(decimal18_3Schema.safeParse('1e3').success).toBe(false);
    expect(decimal18_6Schema.safeParse('1234567890123.0').success).toBe(false);
    expect(decimal18_6Schema.safeParse('-0.1').success).toBe(false);
  });

  it('validates claim, release and paginated READY_TO_SHIP pool contracts', () => {
    const claim = shipmentClaimRequestSchema.parse({
      contractVersion: 1, tenantId: id1, requestId: id2, tripId: id3,
      shipmentId: id1, actorId: id2, expectedTripVersion: 2,
      expectedShipmentVersion: 4,
    });
    const claimReceipt = shipmentClaimReceiptSchema.parse({
      contractVersion: 1, tenantId: id1, requestId: id2, tripId: id3,
      shipmentId: id1, claimId: id3, tripVersion: 3, shipmentVersion: 5,
      claimedAt: timestamp, status: 'CLAIMED',
    });
    expect(() => assertShipmentClaimReceiptBinding(claim, claimReceipt)).not.toThrow();

    const release = shipmentReleaseRequestSchema.parse({
      contractVersion: 1, tenantId: id1, requestId: id2, claimId: id3,
      tripId: id1, shipmentId: id2, actorId: id3, expectedTripVersion: 2,
      expectedShipmentVersion: 4, reason: 'Removed from manifest',
    });
    const releaseReceipt = shipmentReleaseReceiptSchema.parse({
      contractVersion: 1, tenantId: id1, requestId: id2, claimId: id3,
      tripId: id1, shipmentId: id2, tripVersion: 3, shipmentVersion: 5,
      releasedAt: timestamp, status: 'RELEASED',
    });
    expect(() => assertShipmentReleaseReceiptBinding(release, releaseReceipt)).not.toThrow();
    expect(() => assertShipmentReleaseReceiptBinding(release, {
      ...releaseReceipt, shipmentId: id3,
    })).toThrow(/does not match/);
    expect(shipmentReleaseRequestSchema.safeParse({
      contractVersion: 1, tenantId: id1, requestId: id2, claimId: id3,
      tripId: id1, shipmentId: id2, actorId: id3, expectedTripVersion: 2,
      expectedShipmentVersion: 4, reason: '   ',
    }).success).toBe(false);
    expect(shipmentPoolQuerySchema.safeParse({
      contractVersion: 1, warehouseId: id1, page: 1, pageSize: 25,
      status: 'READY_TO_SHIP',
    }).success).toBe(true);
  });

  it('requires exact whole-set batch receipts and preserves rejected zero-grant decisions', () => {
    const request = batchDispatchGrantRequestSchema.parse({
      contractVersion: 1, tenantId: id1, requestId: id2, tripId: id3,
      actorId: id1, expectedTripVersion: 7, dispatchVersion: 1,
      approvedPlanId: id2, inputHash: hash,
      shipments: [
        { shipmentId: id1, orderId: id2, reservationGroupId: id3, orderVersion: 2,
          shipmentVersion: 4, dispatchRequestId: id1 },
        { shipmentId: id2, orderId: id3, reservationGroupId: id1, orderVersion: 5,
          shipmentVersion: 7, dispatchRequestId: id2 },
      ],
    });
    const granted = batchDispatchGrantDecisionSchema.parse({
      contractVersion: 1, decision: 'GRANTED', tenantId: id1, requestId: id2,
      tripId: id3, dispatchVersion: 1,
      actorId: id1, approvedPlanId: id2, inputHash: hash,
      grants: [
        { shipmentId: id1, orderId: id2, grantId: id3, orderVersion: 2,
          reservationGroupId: id3, dispatchRequestId: id1 },
        { shipmentId: id2, orderId: id3, grantId: id1, orderVersion: 5,
          reservationGroupId: id1, dispatchRequestId: id2 },
      ],
      decidedAt: timestamp,
    });
    if (granted.decision !== 'GRANTED') {
      throw new Error('Expected a complete batch grant');
    }
    expect(() => assertBatchDispatchGrantBinding(request, granted)).not.toThrow();
    const partialGrant = batchDispatchGrantDecisionSchema.parse({
      ...granted,
      grants: [granted.grants[0]],
    });
    expect(() => assertBatchDispatchGrantBinding(request, partialGrant)).toThrow(
      /complete requested shipment set/,
    );
    expect(() => assertBatchDispatchGrantBinding(request, {
      ...granted, actorId: id2,
    })).toThrow(/request binding/);
    expect(() => assertBatchDispatchGrantBinding(request, {
      ...granted,
      grants: [{ ...granted.grants[0], dispatchRequestId: id3 }, granted.grants[1]],
    })).toThrow(/complete requested shipment set/);
    expect(batchDispatchGrantDecisionSchema.safeParse({
      contractVersion: 1, decision: 'REJECTED', tenantId: id1, requestId: id2,
      tripId: id3, dispatchVersion: 1, grantCount: 1,
      actorId: id1, approvedPlanId: id2, inputHash: hash,
      reasonCode: 'ORDER_CANCELED', decidedAt: timestamp,
    }).success).toBe(false);
  });

  it('binds preview to tenant, actor, assignee, target, action and exact payload', () => {
    const preview = actionPreviewBindingSchema.parse({
      contractVersion: 1, previewId: id1, tenantId: id2, actingUserId: id3,
      assigneeDriverId: id1, assigneeUserId: id2, action: 'STOP_FAIL',
      targetId: id3, expectedVersion: 9, payloadHash: hash,
      actingReason: 'Covering the assigned driver', expiresAt: timestamp,
    });
    const command = {
      contractVersion: 1 as const, requestId: id1, previewId: id1,
      confirmed: true as const, tenantId: id2, actingUserId: id3, assigneeDriverId: id1,
      assigneeUserId: id2, action: 'STOP_FAIL' as const, targetId: id3,
      expectedVersion: 9, payloadHash: hash,
      actingReason: 'Covering the assigned driver',
    };
    expect(actionConfirmationSchema.safeParse(command).success).toBe(true);
    expect(() => assertPreviewActorBinding(preview, command)).not.toThrow();
    expect(() => assertPreviewActorBinding(preview, {
      ...command, actingUserId: id2,
    })).toThrow(/preview binding/);
    expect(preview.actingUserId).not.toBe(preview.assigneeUserId);
    expect(() => assertPreviewNotExpired(preview, new Date('2026-10-25T06:59:59Z'))).not.toThrow();
    expect(() => assertPreviewNotExpired(preview, new Date(timestamp))).toThrow(/expired/);
    expect(() => assertPreviewNotExpired(preview, new Date('2026-10-25T07:00:01Z'))).toThrow(/expired/);
  });

  it('binds optimizer receipts to the exact request identity and input hash', () => {
    const request = optimizerRequestBindingSchema.parse({
      contractVersion: 1, tenantId: id1, tripId: id2, routeRequestId: id3,
      idempotencyKey: id1, tripVersion: 4, inputHash: hash,
    });
    const receipt = optimizerRunReceiptSchema.parse({
      contractVersion: 1, tenantId: id1, tripId: id2, routeRequestId: id3,
      tripVersion: 4, inputHash: hash, optimizationRunId: id2, status: 'COMPLETED',
      completedAt: timestamp,
    });
    expect(() => assertOptimizerRunBinding(request, receipt)).not.toThrow();
    expect(() => assertOptimizerRunBinding(request, {
      ...receipt, inputHash: 'b'.repeat(64),
    })).toThrow(/does not match/);
    expect(() => assertOptimizerRunBinding(request, {
      ...receipt, tripVersion: 5,
    })).toThrow(/does not match/);
    expect(optimizerRequestBindingSchema.safeParse({
      ...request, inputHash: 'not-a-sha256',
    }).success).toBe(false);
  });

  it('accepts result before the downstream dispatch projection and binds event identity', () => {
    const deferred = deferredDeliveryResultSchema.parse({
      contractVersion: 1, tenantId: id1, eventId: id2, tripId: id3,
      stopId: id1, shipmentId: id2, attempt: 1,
      reasonCode: 'DISPATCH_PROJECTION_NOT_READY', receivedAt: timestamp,
      payloadHash: hash,
    });
    expect(deferred.reasonCode).toBe('DISPATCH_PROJECTION_NOT_READY');

    const event = {
      eventId: id1, eventType: 'DeliveryFailed', eventVersion: 2,
      occurredAt: timestamp, producer: 'transport-service', tenantId: id2,
      actorId: id3, correlationId: id1, causationId: id2,
      aggregateType: 'DeliveryTrip', aggregateId: id3, aggregateVersion: 4,
      payload: {
        contractVersion: 1, tenantId: id2, tripId: id3, stopId: id1,
        shipmentId: id2, attempt: 1, driverId: id1, assigneeUserId: id2,
        outcome: 'FAILED', occurredAt: timestamp, reason: 'Customer unavailable',
        requestId: id3,
      },
    };
    expect(deliveryResultEventSchema.safeParse(event).success).toBe(true);
    expect(deliveryResultEventSchema.safeParse({
      ...event,
      payload: { ...event.payload, tenantId: id1 },
    }).success).toBe(false);
    expect(deliveryResultEventSchema.safeParse({
      ...event,
      aggregateId: id1,
    }).success).toBe(false);
    expect(deliveryResultEventSchema.safeParse({
      ...event,
      eventType: 'DeliveryCompleted',
    }).success).toBe(false);
  });

  it('keeps the existing minimal TripDispatched v1 intact and validates the v2 receipt binding', () => {
    const event = {
      eventId: id1, eventType: 'TripDispatched', eventVersion: 2,
      occurredAt: timestamp, producer: 'transport-service', tenantId: id2,
      actorId: id3, correlationId: id1, causationId: id2,
      aggregateType: 'DeliveryTrip', aggregateId: id3, aggregateVersion: 5,
      payload: {
        contractVersion: 1, tenantId: id2, tripId: id3, warehouseId: id1,
        approvedPlanId: id2, dispatchRequestId: id1, dispatchVersion: 1,
        driverId: id1, assigneeUserId: id2, vehicleId: id3,
        dispatchedAt: timestamp,
        shipments: [{
          shipmentId: id1, orderId: id2, reservationGroupId: id3,
          orderVersion: 4,
        }],
      },
    };
    expect(tripDispatchedEventV2Schema.safeParse(event).success).toBe(true);
    expect(tripDispatchedEventV2Schema.safeParse({
      ...event,
      payload: { ...event.payload, tripId: id1 },
    }).success).toBe(false);
  });
});
