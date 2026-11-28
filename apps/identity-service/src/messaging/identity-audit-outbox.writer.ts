import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import {
  IDENTITY_AUDIT_EVENT_TYPES,
  type AuditOutcome,
  type IdentityMemberRoleChangeType,
  type IdentityMemberRoleChangedPayload,
  type IdentityRoleChangeType,
  type IdentityRolePermissionsUpdatedPayload,
  type IdentitySensitiveLoginKind,
  type IdentitySensitiveLoginPayload,
} from '@logix/messaging';

export interface IdentityOutboxTx {
  outboxEvent?: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
  };
}

export function maskEmailForAudit(email?: string | null): string | null {
  if (!email) return null;
  const trimmed = email.trim();
  const atIndex = trimmed.indexOf('@');
  if (atIndex <= 0) return '***';
  const local = trimmed.slice(0, atIndex);
  const domain = trimmed.slice(atIndex);
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}***${domain}`;
}

export function hashIpForAudit(ipAddress?: string | null): string | null {
  if (!ipAddress) return null;
  const trimmed = ipAddress.trim();
  if (!trimmed) return null;
  return createHash('sha256').update(trimmed).digest('hex').slice(0, 16);
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeUuid(value?: string | null): string | null {
  if (!value) return null;
  return UUID_REGEX.test(value) ? value : null;
}

@Injectable()
export class IdentityAuditOutboxWriter {
  async writeRolePermissionsUpdated(
    tx: IdentityOutboxTx,
    params: {
      tenantId: string;
      actorId: string | null;
      roleId: string;
      roleCode: string;
      roleName: string;
      changeType: IdentityRoleChangeType;
      beforePermissions: string[];
      afterPermissions: string[];
      aggregateVersion?: bigint | number;
      correlationId?: string | null;
      causationId?: string | null;
      reason?: string | null;
    },
  ): Promise<void> {
    if (!tx.outboxEvent || !normalizeUuid(params.tenantId) || !normalizeUuid(params.roleId)) {
      return;
    }

    const correlationId = normalizeUuid(params.correlationId) ?? randomUUID();
    const causationId = normalizeUuid(params.causationId) ?? correlationId;
    const payload: IdentityRolePermissionsUpdatedPayload & { actorId: string | null } = {
      roleId: params.roleId,
      roleCode: params.roleCode,
      roleName: params.roleName,
      changeType: params.changeType,
      beforePermissions: [...params.beforePermissions].sort(),
      afterPermissions: [...params.afterPermissions].sort(),
      reason: params.reason ?? null,
      actorId: normalizeUuid(params.actorId),
    };

    await tx.outboxEvent.create({
      data: {
        id: randomUUID(),
        tenantId: params.tenantId,
        eventType: IDENTITY_AUDIT_EVENT_TYPES.ROLE_PERMISSIONS_UPDATED,
        eventVersion: 1,
        aggregateType: 'Role',
        aggregateId: params.roleId,
        aggregateVersion: BigInt(params.aggregateVersion ?? 1),
        correlationId,
        causationId,
        payload,
        occurredAt: new Date(),
      },
    });
  }

  async writeMemberRoleChanged(
    tx: IdentityOutboxTx,
    params: {
      tenantId: string;
      actorId: string | null;
      aggregateId: string;
      targetUserId: string | null;
      targetEmail?: string | null;
      changeType: IdentityMemberRoleChangeType;
      beforeRoleCodes: string[];
      afterRoleCodes: string[];
      aggregateVersion?: bigint | number;
      correlationId?: string | null;
      causationId?: string | null;
      reason?: string | null;
    },
  ): Promise<void> {
    if (
      !tx.outboxEvent ||
      !normalizeUuid(params.tenantId) ||
      !normalizeUuid(params.aggregateId)
    ) {
      return;
    }

    const correlationId = normalizeUuid(params.correlationId) ?? randomUUID();
    const causationId = normalizeUuid(params.causationId) ?? correlationId;
    const payload: IdentityMemberRoleChangedPayload & { actorId: string | null } = {
      targetUserId: normalizeUuid(params.targetUserId),
      targetEmail: maskEmailForAudit(params.targetEmail),
      changeType: params.changeType,
      beforeRoleCodes: [...params.beforeRoleCodes].sort(),
      afterRoleCodes: [...params.afterRoleCodes].sort(),
      reason: params.reason ?? null,
      actorId: normalizeUuid(params.actorId),
    };

    await tx.outboxEvent.create({
      data: {
        id: randomUUID(),
        tenantId: params.tenantId,
        eventType: IDENTITY_AUDIT_EVENT_TYPES.MEMBER_ROLE_CHANGED,
        eventVersion: 1,
        aggregateType: 'UserTenant',
        aggregateId: params.aggregateId,
        aggregateVersion: BigInt(params.aggregateVersion ?? 1),
        correlationId,
        causationId,
        payload,
        occurredAt: new Date(),
      },
    });
  }

  async writeSensitiveLogin(
    tx: IdentityOutboxTx,
    params: {
      tenantId: string;
      actorId: string | null;
      targetUserId: string | null;
      email?: string | null;
      eventKind: IdentitySensitiveLoginKind;
      outcome: AuditOutcome;
      failureReason?: string | null;
      ipAddress?: string | null;
      userAgent?: string | null;
      aggregateVersion?: bigint | number;
      correlationId?: string | null;
      causationId?: string | null;
    },
  ): Promise<void> {
    const aggregateId = normalizeUuid(params.targetUserId) ?? normalizeUuid(params.actorId);
    if (!tx.outboxEvent || !normalizeUuid(params.tenantId) || !aggregateId) {
      return;
    }

    const correlationId = normalizeUuid(params.correlationId) ?? randomUUID();
    const causationId = normalizeUuid(params.causationId) ?? correlationId;
    const payload: IdentitySensitiveLoginPayload & { actorId: string | null } = {
      targetUserId: normalizeUuid(params.targetUserId),
      emailHint: maskEmailForAudit(params.email),
      eventKind: params.eventKind,
      outcome: params.outcome,
      failureReason: params.failureReason ?? null,
      ipHash: hashIpForAudit(params.ipAddress),
      userAgent: params.userAgent ? params.userAgent.slice(0, 250) : null,
      actorId: normalizeUuid(params.actorId),
    };

    await tx.outboxEvent.create({
      data: {
        id: randomUUID(),
        tenantId: params.tenantId,
        eventType: IDENTITY_AUDIT_EVENT_TYPES.SENSITIVE_LOGIN,
        eventVersion: 1,
        aggregateType: 'User',
        aggregateId,
        aggregateVersion: BigInt(params.aggregateVersion ?? 1),
        correlationId,
        causationId,
        payload,
        occurredAt: new Date(),
      },
    });
  }
}
