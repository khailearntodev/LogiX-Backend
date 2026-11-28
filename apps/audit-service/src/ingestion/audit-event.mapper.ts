import { ServiceId } from '@logix/common';
import {
  AGENT_AUDIT_EVENT_TYPES,
  IDENTITY_AUDIT_EVENT_TYPES,
  type DomainEventEnvelope,
} from '@logix/messaging';
import { redactAuditPayload } from '../redaction/audit-redactor.js';

export type AuditActorType = 'USER' | 'SYSTEM' | 'AGENT';
export type AuditOutcome = 'SUCCESS' | 'DENIED' | 'FAILED';

export interface MappedAuditRecord {
  tenantId: string;
  actorId: string | null;
  actorType: AuditActorType;
  action: string;
  entityType: string;
  entityId: string | null;
  outcome: AuditOutcome;
  beforeData: Record<string, unknown> | null;
  afterData: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
  correlationId: string;
  causationId: string | null;
  sourceService: string;
  sourceEventId: string;
  occurredAt: Date;
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function asUuidOrNull(value: unknown): string | null {
  return typeof value === 'string' && UUID_REGEX.test(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function toUpperSnakeCase(value: string): string {
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s.-]+/g, '_')
    .toUpperCase()
    .slice(0, 100);
}

function resolveActorType(event: DomainEventEnvelope): AuditActorType {
  if (
    event.producer === ServiceId.AGENT_SERVICE ||
    event.eventType === AGENT_AUDIT_EVENT_TYPES.TOOL_CALLED ||
    event.eventType === AGENT_AUDIT_EVENT_TYPES.EXECUTION_COMPLETED
  ) {
    return 'AGENT';
  }
  if (!asUuidOrNull(event.actorId)) {
    return 'SYSTEM';
  }
  return 'USER';
}

function resolveOutcome(
  eventType: string,
  payload: Record<string, unknown>,
): AuditOutcome {
  const explicit = payload.outcome;
  if (explicit === 'SUCCESS' || explicit === 'DENIED' || explicit === 'FAILED') {
    return explicit;
  }
  if (
    eventType === 'DeliveryFailed' ||
    eventType === 'ShipmentDeliveryFailed'
  ) {
    return 'FAILED';
  }
  if (eventType === 'ShipmentCancelRejected') {
    return 'DENIED';
  }
  if (
    eventType === AGENT_AUDIT_EVENT_TYPES.EXECUTION_COMPLETED &&
    payload.success === false
  ) {
    return 'FAILED';
  }
  return 'SUCCESS';
}

function extractBeforeAfter(
  eventType: string,
  payload: Record<string, unknown>,
): {
  beforeData: Record<string, unknown> | null;
  afterData: Record<string, unknown> | null;
} {
  switch (eventType) {
    case IDENTITY_AUDIT_EVENT_TYPES.ROLE_PERMISSIONS_UPDATED:
      return {
        beforeData: {
          permissions: Array.isArray(payload.beforePermissions)
            ? payload.beforePermissions
            : [],
        },
        afterData: {
          roleId: payload.roleId ?? null,
          roleCode: payload.roleCode ?? null,
          roleName: payload.roleName ?? null,
          changeType: payload.changeType ?? null,
          permissions: Array.isArray(payload.afterPermissions)
            ? payload.afterPermissions
            : [],
        },
      };

    case IDENTITY_AUDIT_EVENT_TYPES.MEMBER_ROLE_CHANGED:
      return {
        beforeData: {
          roles: Array.isArray(payload.beforeRoleCodes)
            ? payload.beforeRoleCodes
            : [],
        },
        afterData: {
          targetUserId: payload.targetUserId ?? null,
          targetEmail: payload.targetEmail ?? null,
          changeType: payload.changeType ?? null,
          roles: Array.isArray(payload.afterRoleCodes)
            ? payload.afterRoleCodes
            : [],
        },
      };

    case IDENTITY_AUDIT_EVENT_TYPES.SENSITIVE_LOGIN:
      return {
        beforeData: null,
        afterData: {
          targetUserId: payload.targetUserId ?? null,
          emailHint: payload.emailHint ?? null,
          eventKind: payload.eventKind ?? null,
          outcome: payload.outcome ?? null,
          failureReason: payload.failureReason ?? null,
        },
      };

    case 'InventoryAdjusted':
    case 'StockReceived':
    case 'StockIssued':
      return {
        beforeData: {
          onHand: payload.beforeOnHand ?? null,
        },
        afterData: {
          onHand: payload.afterOnHand ?? null,
          quantityDelta: payload.quantityDelta ?? null,
          reservedQuantity: payload.reservedQuantity ?? null,
          movementType: payload.movementType ?? null,
          warehouseId: payload.warehouseId ?? null,
          productId: payload.productId ?? null,
        },
      };

    case 'OrderCanceled':
      return {
        beforeData: {
          status: payload.previousStatus ?? null,
        },
        afterData: {
          status: 'CANCELED',
          orderNumber: payload.orderNumber ?? null,
          canceledAt: payload.canceledAt ?? null,
          reason: payload.reason ?? null,
        },
      };

    case AGENT_AUDIT_EVENT_TYPES.TOOL_CALLED:
      return {
        beforeData: null,
        afterData: {
          toolCallId: payload.toolCallId ?? null,
          agentExecutionId: payload.agentExecutionId ?? null,
          conversationId: payload.conversationId ?? null,
          toolName: payload.toolName ?? null,
          toolVersion: payload.toolVersion ?? null,
          requiredPermission: payload.requiredPermission ?? null,
          riskLevel: payload.riskLevel ?? null,
          targetService: payload.targetService ?? null,
          status: payload.status ?? null,
          input: payload.sanitizedInput ?? null,
          outputSummary: payload.sanitizedOutputSummary ?? null,
          errorCode: payload.errorCode ?? null,
          latencyMs: payload.latencyMs ?? null,
        },
      };

    default: {
      const explicitBefore =
        payload.beforeData && typeof payload.beforeData === 'object'
          ? asRecord(payload.beforeData)
          : null;
      const explicitAfter =
        payload.afterData && typeof payload.afterData === 'object'
          ? asRecord(payload.afterData)
          : Object.keys(payload).length > 0
            ? payload
            : null;
      return { beforeData: explicitBefore, afterData: explicitAfter };
    }
  }
}

export function mapDomainEventToAuditRecord(
  event: DomainEventEnvelope,
): MappedAuditRecord {
  const tenantId = asUuidOrNull(event.tenantId);
  const correlationId = asUuidOrNull(event.correlationId);
  const sourceEventId = asUuidOrNull(event.eventId);
  const occurredAt = new Date(event.occurredAt);

  if (!tenantId || !correlationId || !sourceEventId || Number.isNaN(occurredAt.getTime())) {
    throw new Error(
      `Invalid audit event identifiers or occurredAt (eventId=${event.eventId})`,
    );
  }

  const rawPayload = asRecord(event.payload);
  const { beforeData, afterData } = extractBeforeAfter(event.eventType, rawPayload);

  const redactedBefore = beforeData
    ? (redactAuditPayload(beforeData) as Record<string, unknown>)
    : null;
  const redactedAfter = afterData
    ? (redactAuditPayload(afterData) as Record<string, unknown>)
    : null;

  const rawMetadata: Record<string, unknown> = {
    eventType: event.eventType,
    eventVersion: event.eventVersion,
    aggregateVersion: event.aggregateVersion,
  };
  if (typeof rawPayload.reason === 'string' && rawPayload.reason.length > 0) {
    rawMetadata.reason = rawPayload.reason;
  }
  if (typeof rawPayload.ipHash === 'string' && rawPayload.ipHash.length > 0) {
    rawMetadata.ipHash = rawPayload.ipHash;
  }
  if (typeof rawPayload.userAgent === 'string' && rawPayload.userAgent.length > 0) {
    rawMetadata.userAgent = rawPayload.userAgent;
  }
  if (typeof rawPayload.toolName === 'string' && rawPayload.toolName.length > 0) {
    rawMetadata.toolName = rawPayload.toolName;
  }

  return {
    tenantId,
    actorId: asUuidOrNull(event.actorId),
    actorType: resolveActorType(event),
    action: toUpperSnakeCase(event.eventType),
    entityType: event.aggregateType.slice(0, 100),
    entityId: asUuidOrNull(event.aggregateId),
    outcome: resolveOutcome(event.eventType, rawPayload),
    beforeData: redactedBefore,
    afterData: redactedAfter,
    metadata: redactAuditPayload(rawMetadata) as Record<string, unknown>,
    correlationId,
    causationId: asUuidOrNull(event.causationId),
    sourceService: event.producer.slice(0, 100),
    sourceEventId,
    occurredAt,
  };
}
