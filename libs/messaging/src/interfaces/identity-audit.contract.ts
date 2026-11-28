/**
 * Shared Identity audit event contracts.
 *
 * Security invariant (NFR-AUD-001): payloads must NEVER carry raw passwords,
 * password hashes, JWTs, refresh tokens, session tokens, or API secrets.
 */

export const IDENTITY_AUDIT_EVENT_TYPES = {
  ROLE_PERMISSIONS_UPDATED: "IdentityRolePermissionsUpdated",
  MEMBER_ROLE_CHANGED: "IdentityMemberRoleChanged",
  SENSITIVE_LOGIN: "IdentitySensitiveLogin",
} as const;

export type IdentityAuditEventType =
  (typeof IDENTITY_AUDIT_EVENT_TYPES)[keyof typeof IDENTITY_AUDIT_EVENT_TYPES];

export type IdentityRoleChangeType =
  | "CREATED"
  | "UPDATED"
  | "DELETED"
  | "PERMISSIONS_UPDATED";

export interface IdentityRolePermissionsUpdatedPayload {
  roleId: string;
  roleCode: string;
  roleName: string;
  changeType: IdentityRoleChangeType;
  beforePermissions: string[];
  afterPermissions: string[];
  reason?: string | null;
}

export type IdentityMemberRoleChangeType =
  | "ROLE_ASSIGNED"
  | "ROLE_REVOKED"
  | "MEMBER_INVITED"
  | "MEMBER_REMOVED";

export interface IdentityMemberRoleChangedPayload {
  targetUserId: string | null;
  targetEmail?: string | null;
  changeType: IdentityMemberRoleChangeType;
  beforeRoleCodes: string[];
  afterRoleCodes: string[];
  reason?: string | null;
}

export type IdentitySensitiveLoginKind =
  | "LOGIN_SUCCEEDED"
  | "LOGIN_FAILED"
  | "PASSWORD_CHANGED"
  | "TENANT_SWITCHED"
  | "SESSION_REVOKED";

export type AuditOutcome = "SUCCESS" | "DENIED" | "FAILED";

export interface IdentitySensitiveLoginPayload {
  targetUserId: string | null;
  emailHint?: string | null;
  eventKind: IdentitySensitiveLoginKind;
  outcome: AuditOutcome;
  failureReason?: string | null;
  ipHash?: string | null;
  userAgent?: string | null;
}
