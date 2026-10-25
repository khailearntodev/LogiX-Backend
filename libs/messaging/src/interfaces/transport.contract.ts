import { z } from 'zod';

export const TRANSPORT_CONTRACT_VERSION = 1;
export const TRANSPORT_DEFAULT_PAGE_SIZE = 20;
export const TRANSPORT_MAX_PAGE_SIZE = 100;
export const TRANSPORT_MAX_PAGE_NUMBER = Math.floor(2_147_483_647 / TRANSPORT_MAX_PAGE_SIZE);
export const TRANSPORT_PREVIEW_TTL_SECONDS = 300;
export const TRANSPORT_MAX_REASON_LENGTH = 1_000;

export const transportUuidSchema = z.string().uuid();
export const transportVersionSchema = z.number().int().positive().safe();
export const decimal18_3Schema = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,14})(?:\.\d{1,3})?$/);
export const decimal18_6Schema = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/);
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const timestampSchema = z.string().datetime({ offset: true });

export const shipmentClaimRequestSchema = z
  .object({
    contractVersion: z.literal(TRANSPORT_CONTRACT_VERSION),
    tenantId: transportUuidSchema,
    requestId: transportUuidSchema,
    tripId: transportUuidSchema,
    shipmentId: transportUuidSchema,
    actorId: transportUuidSchema,
    expectedTripVersion: transportVersionSchema,
    expectedShipmentVersion: transportVersionSchema,
  })
  .strict();
export type ShipmentClaimRequest = z.infer<typeof shipmentClaimRequestSchema>;

export const shipmentClaimReceiptSchema = z
  .object({
    contractVersion: z.literal(TRANSPORT_CONTRACT_VERSION),
    tenantId: transportUuidSchema,
    requestId: transportUuidSchema,
    tripId: transportUuidSchema,
    shipmentId: transportUuidSchema,
    claimId: transportUuidSchema,
    tripVersion: transportVersionSchema,
    shipmentVersion: transportVersionSchema,
    claimedAt: timestampSchema,
    status: z.literal('CLAIMED'),
  })
  .strict();

export const shipmentReleaseRequestSchema = z
  .object({
    contractVersion: z.literal(TRANSPORT_CONTRACT_VERSION),
    tenantId: transportUuidSchema,
    requestId: transportUuidSchema,
    claimId: transportUuidSchema,
    tripId: transportUuidSchema,
    shipmentId: transportUuidSchema,
    actorId: transportUuidSchema,
    expectedTripVersion: transportVersionSchema,
    expectedShipmentVersion: transportVersionSchema,
    reason: z.string().trim().min(1),
  })
  .strict();

export const shipmentReleaseReceiptSchema = z
  .object({
    contractVersion: z.literal(TRANSPORT_CONTRACT_VERSION),
    tenantId: transportUuidSchema,
    requestId: transportUuidSchema,
    claimId: transportUuidSchema,
    tripId: transportUuidSchema,
    shipmentId: transportUuidSchema,
    tripVersion: transportVersionSchema,
    shipmentVersion: transportVersionSchema,
    releasedAt: timestampSchema,
    status: z.literal('RELEASED'),
  })
  .strict();

export const shipmentPoolQuerySchema = z
  .object({
    contractVersion: z.literal(TRANSPORT_CONTRACT_VERSION),
    warehouseId: transportUuidSchema,
    page: transportVersionSchema.max(TRANSPORT_MAX_PAGE_NUMBER),
    pageSize: transportVersionSchema.max(TRANSPORT_MAX_PAGE_SIZE),
    status: z.literal('READY_TO_SHIP').optional(),
  })
  .strict();

export const shipmentPoolItemSchema = z
  .object({
    shipmentId: transportUuidSchema,
    orderId: transportUuidSchema,
    warehouseId: transportUuidSchema,
    shipmentVersion: transportVersionSchema,
    orderVersion: transportVersionSchema,
    status: z.literal('READY_TO_SHIP'),
    totalWeight: decimal18_3Schema,
    totalVolume: decimal18_6Schema,
  })
  .strict();

export const shipmentPoolPageSchema = z
  .object({
    items: z.array(shipmentPoolItemSchema),
    total: z.number().int().nonnegative().safe(),
    page: transportVersionSchema,
    pageSize: transportVersionSchema,
  })
  .strict();

export const batchDispatchGrantRequestSchema = z
  .object({
    contractVersion: z.literal(TRANSPORT_CONTRACT_VERSION),
    tenantId: transportUuidSchema,
    requestId: transportUuidSchema,
    tripId: transportUuidSchema,
    actorId: transportUuidSchema,
    expectedTripVersion: transportVersionSchema,
    dispatchVersion: transportVersionSchema,
    approvedPlanId: transportUuidSchema,
    inputHash: sha256Schema,
    shipments: z
      .array(
        z
          .object({
            shipmentId: transportUuidSchema,
            orderId: transportUuidSchema,
            reservationGroupId: transportUuidSchema,
            orderVersion: transportVersionSchema,
            shipmentVersion: transportVersionSchema,
            dispatchRequestId: transportUuidSchema,
          })
          .strict(),
      )
      .nonempty(),
  })
  .strict()
  .refine(
    (request) =>
      new Set(request.shipments.map((item) => item.shipmentId)).size ===
        request.shipments.length &&
      new Set(request.shipments.map((item) => item.orderId)).size ===
        request.shipments.length &&
      new Set(request.shipments.map((item) => item.dispatchRequestId)).size ===
        request.shipments.length,
    { message: 'Batch shipment and order identities must be unique' },
  );

export const batchDispatchGrantDecisionSchema = z
  .discriminatedUnion('decision', [
    z
      .object({
        contractVersion: z.literal(TRANSPORT_CONTRACT_VERSION),
        decision: z.literal('GRANTED'),
        tenantId: transportUuidSchema,
        requestId: transportUuidSchema,
        tripId: transportUuidSchema,
        dispatchVersion: transportVersionSchema,
        actorId: transportUuidSchema,
        approvedPlanId: transportUuidSchema,
        inputHash: sha256Schema,
        grants: z
          .array(
            z
              .object({
                shipmentId: transportUuidSchema,
                orderId: transportUuidSchema,
                grantId: transportUuidSchema,
                orderVersion: transportVersionSchema,
                reservationGroupId: transportUuidSchema,
                dispatchRequestId: transportUuidSchema,
              })
              .strict(),
          )
          .nonempty(),
        decidedAt: timestampSchema,
      })
      .strict(),
    z
      .object({
        contractVersion: z.literal(TRANSPORT_CONTRACT_VERSION),
        decision: z.literal('REJECTED'),
        tenantId: transportUuidSchema,
        requestId: transportUuidSchema,
        tripId: transportUuidSchema,
        dispatchVersion: transportVersionSchema,
        actorId: transportUuidSchema,
        approvedPlanId: transportUuidSchema,
        inputHash: sha256Schema,
        grantCount: z.literal(0),
        reasonCode: z.string().min(1),
        decidedAt: timestampSchema,
      })
      .strict(),
  ]);

export const actionPreviewBindingSchema = z
  .object({
    contractVersion: z.literal(TRANSPORT_CONTRACT_VERSION),
    previewId: transportUuidSchema,
    tenantId: transportUuidSchema,
    actingUserId: transportUuidSchema,
    assigneeDriverId: transportUuidSchema,
    assigneeUserId: transportUuidSchema,
    action: z.enum(['ROUTE_APPROVE', 'TRIP_DISPATCH', 'STOP_ARRIVE', 'STOP_DELIVER', 'STOP_FAIL']),
    targetId: transportUuidSchema,
    expectedVersion: transportVersionSchema,
    tripVersion: transportVersionSchema.optional(),
    stopVersion: transportVersionSchema.optional(),
    planId: transportUuidSchema.optional(),
    planVersion: transportVersionSchema.optional(),
    inputHash: sha256Schema.optional(),
    payloadHash: sha256Schema,
    actingReason: z.string().trim().min(1).max(TRANSPORT_MAX_REASON_LENGTH).optional(),
    expiresAt: timestampSchema,
  })
  .strict();

export const actionConfirmationSchema = z
  .object({
    contractVersion: z.literal(TRANSPORT_CONTRACT_VERSION),
    requestId: transportUuidSchema,
    previewId: transportUuidSchema,
    confirmed: z.literal(true),
    tenantId: transportUuidSchema,
    actingUserId: transportUuidSchema,
    assigneeDriverId: transportUuidSchema,
    assigneeUserId: transportUuidSchema,
    action: actionPreviewBindingSchema.shape.action,
    targetId: transportUuidSchema,
    expectedVersion: transportVersionSchema,
    tripVersion: transportVersionSchema.optional(),
    stopVersion: transportVersionSchema.optional(),
    planId: transportUuidSchema.optional(),
    planVersion: transportVersionSchema.optional(),
    inputHash: sha256Schema.optional(),
    payloadHash: sha256Schema,
    actingReason: z.string().trim().min(1).max(TRANSPORT_MAX_REASON_LENGTH).optional(),
  })
  .strict();

export const tripDispatchedPayloadV2Schema = z
  .object({
    contractVersion: z.literal(TRANSPORT_CONTRACT_VERSION),
    tenantId: transportUuidSchema,
    tripId: transportUuidSchema,
    warehouseId: transportUuidSchema,
    approvedPlanId: transportUuidSchema,
    dispatchRequestId: transportUuidSchema,
    dispatchVersion: transportVersionSchema,
    driverId: transportUuidSchema,
    assigneeUserId: transportUuidSchema,
    vehicleId: transportUuidSchema,
    dispatchedAt: timestampSchema,
    shipments: z
      .array(
        z
          .object({
            shipmentId: transportUuidSchema,
            orderId: transportUuidSchema,
            reservationGroupId: transportUuidSchema,
            orderVersion: transportVersionSchema,
          })
          .strict(),
      )
      .nonempty(),
  })
  .strict()
  .refine(
    (payload) =>
      new Set(payload.shipments.map((shipment) => shipment.shipmentId)).size ===
        payload.shipments.length &&
      new Set(payload.shipments.map((shipment) => shipment.orderId)).size ===
        payload.shipments.length,
    { message: 'Dispatched shipment and order identities must be unique' },
  );

export const tripDispatchedEventV2Schema = z
  .object({
    eventId: transportUuidSchema,
    eventType: z.literal('TripDispatched'),
    eventVersion: z.literal(2),
    occurredAt: timestampSchema,
    producer: z.literal('transport-service'),
    tenantId: transportUuidSchema,
    actorId: transportUuidSchema.nullable(),
    correlationId: transportUuidSchema,
    causationId: transportUuidSchema,
    aggregateType: z.literal('DeliveryTrip'),
    aggregateId: transportUuidSchema,
    aggregateVersion: transportVersionSchema,
    payload: tripDispatchedPayloadV2Schema,
  })
  .strict()
  .superRefine((event, context) => {
    if (event.payload.tenantId !== event.tenantId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['payload', 'tenantId'],
        message: 'Event and payload tenant identities must match',
      });
    }
    if (event.payload.tripId !== event.aggregateId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['payload', 'tripId'],
        message: 'Payload trip identity must match the event aggregate',
      });
    }
  });

export const optimizerRequestBindingSchema = z
  .object({
    contractVersion: z.literal(TRANSPORT_CONTRACT_VERSION),
    tenantId: transportUuidSchema,
    tripId: transportUuidSchema,
    routeRequestId: transportUuidSchema,
    idempotencyKey: transportUuidSchema,
    tripVersion: transportVersionSchema,
    inputHash: sha256Schema,
  })
  .strict();

export const optimizerRunReceiptSchema = z
  .object({
    contractVersion: z.literal(TRANSPORT_CONTRACT_VERSION),
    tenantId: transportUuidSchema,
    tripId: transportUuidSchema,
    routeRequestId: transportUuidSchema,
    tripVersion: transportVersionSchema,
    inputHash: sha256Schema,
    optimizationRunId: transportUuidSchema,
    status: z.enum(['ACCEPTED', 'COMPLETED', 'FAILED']),
    completedAt: timestampSchema.nullable(),
  })
  .strict();

export const deliveryResultPayloadSchema = z
  .object({
    contractVersion: z.literal(TRANSPORT_CONTRACT_VERSION),
    tenantId: transportUuidSchema,
    tripId: transportUuidSchema,
    stopId: transportUuidSchema,
    shipmentId: transportUuidSchema,
    attempt: transportVersionSchema,
    driverId: transportUuidSchema,
    assigneeUserId: transportUuidSchema,
    outcome: z.enum(['DELIVERED', 'FAILED']),
    occurredAt: timestampSchema,
    reason: z.string().trim().min(1).nullable(),
    requestId: transportUuidSchema,
  })
  .strict()
  .refine(
    (payload) =>
      payload.outcome === 'FAILED'
        ? payload.reason !== null
        : payload.reason === null,
    { message: 'Delivery result reason must match its outcome' },
  );

export const deferredDeliveryResultSchema = z
  .object({
    contractVersion: z.literal(TRANSPORT_CONTRACT_VERSION),
    tenantId: transportUuidSchema,
    eventId: transportUuidSchema,
    tripId: transportUuidSchema,
    stopId: transportUuidSchema,
    shipmentId: transportUuidSchema,
    attempt: transportVersionSchema,
    reasonCode: z.literal('DISPATCH_PROJECTION_NOT_READY'),
    receivedAt: timestampSchema,
    payloadHash: sha256Schema,
  })
  .strict();

export const deliveryResultEventSchema = z
  .object({
    eventId: transportUuidSchema,
    eventType: z.enum(['DeliveryCompleted', 'DeliveryFailed']),
    eventVersion: z.literal(2),
    occurredAt: timestampSchema,
    producer: z.literal('transport-service'),
    tenantId: transportUuidSchema,
    actorId: transportUuidSchema,
    correlationId: transportUuidSchema,
    causationId: transportUuidSchema,
    aggregateType: z.literal('DeliveryTrip'),
    aggregateId: transportUuidSchema,
    aggregateVersion: transportVersionSchema,
    payload: deliveryResultPayloadSchema,
  })
  .strict()
  .superRefine((event, context) => {
    if (event.payload.tenantId !== event.tenantId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['payload', 'tenantId'],
        message: 'Event and payload tenant identities must match',
      });
    }
    if (event.payload.tripId !== event.aggregateId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['payload', 'tripId'],
        message: 'Payload trip identity must match the event aggregate',
      });
    }
    if (
      (event.eventType === 'DeliveryCompleted' &&
        event.payload.outcome !== 'DELIVERED') ||
      (event.eventType === 'DeliveryFailed' &&
        event.payload.outcome !== 'FAILED')
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['payload', 'outcome'],
        message: 'Event type and delivery outcome must match',
      });
    }
  });

export function assertPreviewActorBinding(
  preview: z.infer<typeof actionPreviewBindingSchema>,
  command: z.infer<typeof actionConfirmationSchema>,
): void {
  actionPreviewBindingSchema.parse(preview);
  actionConfirmationSchema.parse(command);
  if (
    preview.previewId !== command.previewId ||
    preview.tenantId !== command.tenantId ||
    preview.actingUserId !== command.actingUserId ||
    preview.assigneeDriverId !== command.assigneeDriverId ||
    preview.assigneeUserId !== command.assigneeUserId ||
    preview.action !== command.action ||
    preview.targetId !== command.targetId ||
    preview.expectedVersion !== command.expectedVersion ||
    preview.tripVersion !== command.tripVersion ||
    preview.stopVersion !== command.stopVersion ||
    preview.planId !== command.planId ||
    preview.planVersion !== command.planVersion ||
    preview.inputHash !== command.inputHash ||
    preview.payloadHash !== command.payloadHash ||
    preview.actingReason !== command.actingReason
  ) {
    throw new Error('Action command does not match its preview binding');
  }
}

export function assertPreviewNotExpired(
  preview: z.infer<typeof actionPreviewBindingSchema>,
  now: Date,
): void {
  actionPreviewBindingSchema.parse(preview);
  if (!Number.isFinite(now.getTime()) || now.getTime() >= Date.parse(preview.expiresAt)) {
    throw new Error('Action preview has expired; request a new preview');
  }
}

export function assertShipmentClaimReceiptBinding(
  request: z.infer<typeof shipmentClaimRequestSchema>,
  receipt: z.infer<typeof shipmentClaimReceiptSchema>,
): void {
  shipmentClaimRequestSchema.parse(request);
  shipmentClaimReceiptSchema.parse(receipt);
  if (
    request.tenantId !== receipt.tenantId ||
    request.requestId !== receipt.requestId ||
    request.tripId !== receipt.tripId ||
    request.shipmentId !== receipt.shipmentId
  ) {
    throw new Error('Shipment claim receipt does not match its request binding');
  }
}

export function assertShipmentReleaseReceiptBinding(
  request: z.infer<typeof shipmentReleaseRequestSchema>,
  receipt: z.infer<typeof shipmentReleaseReceiptSchema>,
): void {
  shipmentReleaseRequestSchema.parse(request);
  shipmentReleaseReceiptSchema.parse(receipt);
  if (
    request.tenantId !== receipt.tenantId ||
    request.requestId !== receipt.requestId ||
    request.claimId !== receipt.claimId ||
    request.tripId !== receipt.tripId ||
    request.shipmentId !== receipt.shipmentId
  ) {
    throw new Error('Shipment release receipt does not match its request binding');
  }
}

export function assertBatchDispatchGrantBinding(
  request: z.infer<typeof batchDispatchGrantRequestSchema>,
  decision: z.infer<typeof batchDispatchGrantDecisionSchema>,
): void {
  batchDispatchGrantRequestSchema.parse(request);
  batchDispatchGrantDecisionSchema.parse(decision);
  if (
    request.tenantId !== decision.tenantId ||
    request.requestId !== decision.requestId ||
    request.tripId !== decision.tripId ||
    request.dispatchVersion !== decision.dispatchVersion ||
    request.actorId !== decision.actorId ||
    request.approvedPlanId !== decision.approvedPlanId ||
    request.inputHash !== decision.inputHash
  ) {
    throw new Error('Batch grant decision does not match its request binding');
  }
  if (decision.decision === 'REJECTED') return;

  const requested = new Set(request.shipments.map((item) => item.shipmentId));
  const granted = new Set(decision.grants.map((item) => item.shipmentId));
  if (
    requested.size !== granted.size ||
    [...requested].some((shipmentId) => !granted.has(shipmentId)) ||
    new Set(decision.grants.map((item) => item.orderId)).size !==
      decision.grants.length ||
    request.shipments.some((item) => {
      const grant = decision.grants.find(
        (candidate) => candidate.shipmentId === item.shipmentId,
      );
      return (
        !grant ||
        grant.orderId !== item.orderId ||
        grant.orderVersion !== item.orderVersion ||
        grant.reservationGroupId !== item.reservationGroupId ||
        grant.dispatchRequestId !== item.dispatchRequestId
      );
    })
  ) {
    throw new Error('Batch grants must cover the complete requested shipment set');
  }
}

export function assertOptimizerRunBinding(
  request: z.infer<typeof optimizerRequestBindingSchema>,
  receipt: z.infer<typeof optimizerRunReceiptSchema>,
): void {
  optimizerRequestBindingSchema.parse(request);
  optimizerRunReceiptSchema.parse(receipt);
  if (
    request.tenantId !== receipt.tenantId ||
    request.tripId !== receipt.tripId ||
    request.routeRequestId !== receipt.routeRequestId ||
    request.tripVersion !== receipt.tripVersion ||
    request.inputHash !== receipt.inputHash
  ) {
    throw new Error('Optimizer run receipt does not match its request binding');
  }
}

export type ShipmentClaimReceipt = z.infer<typeof shipmentClaimReceiptSchema>;
export type ShipmentReleaseRequest = z.infer<typeof shipmentReleaseRequestSchema>;
export type ShipmentReleaseReceipt = z.infer<typeof shipmentReleaseReceiptSchema>;
export type ShipmentPoolQuery = z.infer<typeof shipmentPoolQuerySchema>;
export type ShipmentPoolItem = z.infer<typeof shipmentPoolItemSchema>;
export type ShipmentPoolPage = z.infer<typeof shipmentPoolPageSchema>;
export type BatchDispatchGrantRequest = z.infer<typeof batchDispatchGrantRequestSchema>;
export type BatchDispatchGrantDecision = z.infer<typeof batchDispatchGrantDecisionSchema>;
export type ActionPreviewBinding = z.infer<typeof actionPreviewBindingSchema>;
export type ActionConfirmation = z.infer<typeof actionConfirmationSchema>;
export type TripDispatchedPayloadV2 = z.infer<typeof tripDispatchedPayloadV2Schema>;
export type TripDispatchedEventV2 = z.infer<typeof tripDispatchedEventV2Schema>;
export type OptimizerRequestBinding = z.infer<typeof optimizerRequestBindingSchema>;
export type OptimizerRunReceipt = z.infer<typeof optimizerRunReceiptSchema>;
export type DeliveryResultPayload = z.infer<typeof deliveryResultPayloadSchema>;
export type DeferredDeliveryResult = z.infer<typeof deferredDeliveryResultSchema>;
export type DeliveryResultEvent = z.infer<typeof deliveryResultEventSchema>;
