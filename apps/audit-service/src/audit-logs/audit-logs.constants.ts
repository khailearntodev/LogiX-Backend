export const AUDIT_DEFAULT_PAGE = 1;
export const AUDIT_DEFAULT_LIMIT = 20;
export const AUDIT_MAX_LIMIT = 100;

export const AUDIT_OUTCOMES = ['SUCCESS', 'DENIED', 'FAILED'] as const;
export type AuditOutcomeFilter = (typeof AUDIT_OUTCOMES)[number];

export const AUDIT_ACTOR_TYPES = ['USER', 'SYSTEM', 'AGENT'] as const;
export type AuditActorTypeFilter = (typeof AUDIT_ACTOR_TYPES)[number];
