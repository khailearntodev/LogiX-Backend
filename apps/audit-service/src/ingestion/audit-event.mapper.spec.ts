import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ServiceId } from '@logix/common';
import {
  AGENT_AUDIT_EVENT_TYPES,
  IDENTITY_AUDIT_EVENT_TYPES,
  type DomainEventEnvelope,
} from '@logix/messaging';
import { REDACTED_VALUE } from '../redaction/audit-redactor.js';
import { mapDomainEventToAuditRecord } from './audit-event.mapper.js';

function makeEnvelope(
  overrides: Partial<DomainEventEnvelope>,
): DomainEventEnvelope {
  const corrId = randomUUID();
  return {
    eventId: randomUUID(),
    eventType: 'OrderConfirmed',
    eventVersion: 1,
    occurredAt: '2026-11-24T10:00:00.000Z',
    producer: ServiceId.ORDER_SERVICE,
    tenantId: randomUUID(),
    actorId: randomUUID(),
    correlationId: corrId,
    causationId: corrId,
    aggregateType: 'SalesOrder',
    aggregateId: randomUUID(),
    aggregateVersion: 2,
    payload: {},
    ...overrides,
  };
}

describe('mapDomainEventToAuditRecord', () => {
  it('maps IdentityRolePermissionsUpdated with before/after permission arrays', () => {
    const roleId = randomUUID();
    const record = mapDomainEventToAuditRecord(
      makeEnvelope({
        eventType: IDENTITY_AUDIT_EVENT_TYPES.ROLE_PERMISSIONS_UPDATED,
        producer: ServiceId.IDENTITY_SERVICE,
        aggregateType: 'Role',
        aggregateId: roleId,
        payload: {
          roleId,
          roleCode: 'MANAGER',
          roleName: 'Manager',
          changeType: 'PERMISSIONS_UPDATED',
          beforePermissions: ['order:sales-order:read'],
          afterPermissions: ['order:sales-order:read', 'audit:log:read'],
        },
      }),
    );

    expect(record.actorType).toBe('USER');
    expect(record.action).toBe('IDENTITY_ROLE_PERMISSIONS_UPDATED');
    expect(record.outcome).toBe('SUCCESS');
    expect(record.beforeData).toEqual({ permissions: ['order:sales-order:read'] });
    expect(record.afterData).toEqual({
      roleId,
      roleCode: 'MANAGER',
      roleName: 'Manager',
      changeType: 'PERMISSIONS_UPDATED',
      permissions: ['order:sales-order:read', 'audit:log:read'],
    });
  });

  it('maps InventoryAdjusted with beforeOnHand and afterOnHand', () => {
    const record = mapDomainEventToAuditRecord(
      makeEnvelope({
        eventType: 'InventoryAdjusted',
        producer: ServiceId.INVENTORY_SERVICE,
        aggregateType: 'StockMovement',
        actorId: null,
        payload: {
          warehouseId: randomUUID(),
          productId: randomUUID(),
          movementType: 'ADJUSTMENT',
          beforeOnHand: '100.000',
          afterOnHand: '95.000',
          quantityDelta: '-5.000',
          reservedQuantity: '10.000',
          reason: 'Kiểm kê định kỳ',
        },
      }),
    );

    expect(record.actorType).toBe('SYSTEM');
    expect(record.action).toBe('INVENTORY_ADJUSTED');
    expect(record.beforeData).toEqual({ onHand: '100.000' });
    expect(record.afterData?.onHand).toBe('95.000');
    expect(record.metadata.reason).toBe('Kiểm kê định kỳ');
  });

  it('maps AgentToolCalled as AGENT actor and redacts any leaked secret inside tool input', () => {
    const record = mapDomainEventToAuditRecord(
      makeEnvelope({
        eventType: AGENT_AUDIT_EVENT_TYPES.TOOL_CALLED,
        producer: ServiceId.AGENT_SERVICE,
        aggregateType: 'ToolCall',
        payload: {
          toolCallId: randomUUID(),
          agentExecutionId: randomUUID(),
          conversationId: randomUUID(),
          toolName: 'confirm_order',
          toolVersion: 'v1',
          requiredPermission: 'order:sales-order:approve',
          riskLevel: 'HIGH',
          targetService: 'order-service',
          status: 'REJECTED',
          outcome: 'DENIED',
          sanitizedInput: {
            orderId: 'ord-1',
            authorization: 'Bearer secret-token-value-12345',
          },
          latencyMs: 45,
        },
      }),
    );

    expect(record.actorType).toBe('AGENT');
    expect(record.action).toBe('AGENT_TOOL_CALLED');
    expect(record.outcome).toBe('DENIED');
    const toolInput = record.afterData?.input as Record<string, unknown>;
    expect(toolInput.authorization).toBe(REDACTED_VALUE);
    expect(record.metadata.toolName).toBe('confirm_order');
  });

  it('rejects malformed non-UUID tenantId or invalid occurredAt', () => {
    expect(() =>
      mapDomainEventToAuditRecord(makeEnvelope({ tenantId: 'not-a-uuid' })),
    ).toThrow();
    expect(() =>
      mapDomainEventToAuditRecord(makeEnvelope({ occurredAt: 'invalid-date' })),
    ).toThrow();
  });
});
