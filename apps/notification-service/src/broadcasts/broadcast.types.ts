import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { NotificationSeverity } from '../notifications/notification.constants.js';

export type BroadcastAudience =
  | { kind: 'ALL' }
  | { kind: 'ROLES'; roleIds: string[] }
  | { kind: 'USERS'; userIds: string[] };

export const broadcastAudienceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ALL') }),
  z.object({
    kind: z.literal('ROLES'),
    roleIds: z.array(z.string().uuid()).min(1),
  }),
  z.object({
    kind: z.literal('USERS'),
    userIds: z.array(z.string().uuid()).min(1),
  }),
]);

export const broadcastCommandPayloadSchema = z.object({
  broadcastId: z.string().uuid(),
  notificationId: z.string().uuid(),
  tenantId: z.string().uuid(),
  actorId: z.string().uuid(),
  audience: broadcastAudienceSchema,
  snapshotAt: z.string().datetime(),
  requestedAt: z.string().datetime(),
});

export type BroadcastCommandPayload = z.infer<
  typeof broadcastCommandPayloadSchema
>;

export interface CreateBroadcastInput {
  tenantId: string;
  actorId: string;
  idempotencyKey: string;
  correlationId: string;
  title: string;
  body: string;
  severity: NotificationSeverity;
  audience: BroadcastAudience;
  link: string | null;
}

export interface EnqueueBroadcastResult {
  id: string;
  status: string;
  deduplicated: boolean;
}

export class BroadcastIdempotencyConflictError extends Error {
  constructor(message = 'Idempotency-Key already used with a different payload') {
    super(message);
    this.name = 'BroadcastIdempotencyConflictError';
  }
}

export function canonicalizeBroadcastAudience(
  audience: BroadcastAudience,
): BroadcastAudience {
  if (audience.kind === 'ROLES') {
    return { kind: 'ROLES', roleIds: [...new Set(audience.roleIds)].sort() };
  }
  if (audience.kind === 'USERS') {
    return { kind: 'USERS', userIds: [...new Set(audience.userIds)].sort() };
  }
  return { kind: 'ALL' };
}

export function hashBroadcastPayload(input: {
  title: string;
  body: string;
  severity: NotificationSeverity;
  audience: BroadcastAudience;
  link: string | null;
}): string {
  const canonical = JSON.stringify({
    title: input.title,
    body: input.body,
    severity: input.severity,
    link: input.link,
    audience: canonicalizeBroadcastAudience(input.audience),
  });
  return createHash('sha256').update(canonical).digest('hex');
}
