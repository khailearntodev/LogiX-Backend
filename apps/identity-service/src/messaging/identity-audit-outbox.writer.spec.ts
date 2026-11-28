import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { IDENTITY_AUDIT_EVENT_TYPES } from '@logix/messaging';
import {
  IdentityAuditOutboxWriter,
  hashIpForAudit,
  maskEmailForAudit,
} from './identity-audit-outbox.writer.js';

describe('IdentityAuditOutboxWriter', () => {
  const writer = new IdentityAuditOutboxWriter();

  it('masks email addresses and hashes IP addresses without leaking raw values', () => {
    expect(maskEmailForAudit('owner@logix.vn')).toBe('ow***@logix.vn');
    expect(maskEmailForAudit('a@logix.vn')).toBe('a***@logix.vn');
    expect(maskEmailForAudit(null)).toBeNull();

    const hashed = hashIpForAudit('192.168.1.42');
    expect(hashed).toHaveLength(16);
    expect(hashed).not.toContain('192.168');
    expect(hashIpForAudit('192.168.1.42')).toBe(hashed);
    expect(hashIpForAudit('')).toBeNull();
  });

  it('writes IdentityRolePermissionsUpdated with sorted before/after permissions and actorId', async () => {
    const create = vi.fn().mockResolvedValue({});
    const tenantId = randomUUID();
    const roleId = randomUUID();
    const actorId = randomUUID();

    await writer.writeRolePermissionsUpdated(
      { outboxEvent: { create } },
      {
        tenantId,
        actorId,
        roleId,
        roleCode: 'MANAGER',
        roleName: 'Manager',
        changeType: 'PERMISSIONS_UPDATED',
        beforePermissions: ['order:sales-order:read', 'audit:log:read'],
        afterPermissions: ['order:sales-order:read'],
        aggregateVersion: 3,
      },
    );

    expect(create).toHaveBeenCalledOnce();
    const record = create.mock.calls[0][0].data;
    expect(record.tenantId).toBe(tenantId);
    expect(record.eventType).toBe(IDENTITY_AUDIT_EVENT_TYPES.ROLE_PERMISSIONS_UPDATED);
    expect(record.eventVersion).toBe(1);
    expect(record.aggregateType).toBe('Role');
    expect(record.aggregateId).toBe(roleId);
    expect(record.aggregateVersion).toBe(3n);
    expect(record.payload).toEqual({
      roleId,
      roleCode: 'MANAGER',
      roleName: 'Manager',
      changeType: 'PERMISSIONS_UPDATED',
      beforePermissions: ['audit:log:read', 'order:sales-order:read'],
      afterPermissions: ['order:sales-order:read'],
      reason: null,
      actorId,
    });
  });

  it('writes IdentitySensitiveLogin without raw email, password, or token fields', async () => {
    const create = vi.fn().mockResolvedValue({});
    const tenantId = randomUUID();
    const userId = randomUUID();

    await writer.writeSensitiveLogin(
      { outboxEvent: { create } },
      {
        tenantId,
        actorId: userId,
        targetUserId: userId,
        email: 'admin@logix.vn',
        eventKind: 'LOGIN_FAILED',
        outcome: 'FAILED',
        failureReason: 'INVALID_CREDENTIALS',
        ipAddress: '10.0.0.15',
        userAgent: 'Mozilla/5.0',
      },
    );

    expect(create).toHaveBeenCalledOnce();
    const record = create.mock.calls[0][0].data;
    expect(record.eventType).toBe(IDENTITY_AUDIT_EVENT_TYPES.SENSITIVE_LOGIN);
    expect(record.payload.emailHint).toBe('ad***@logix.vn');
    expect(record.payload.ipHash).toBe(hashIpForAudit('10.0.0.15'));
    expect(record.payload.outcome).toBe('FAILED');
    expect(JSON.stringify(record.payload)).not.toContain('admin@logix.vn');
    expect(JSON.stringify(record.payload)).not.toContain('10.0.0.15');
    expect(record.payload).not.toHaveProperty('password');
    expect(record.payload).not.toHaveProperty('token');
  });
});
