import { NOTIFICATION_ENTITY_TYPES } from './notification.constants.js';

export function toJsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function resolveNotificationLink(
  entityType: string | null,
  entityId: string | null,
  data: Record<string, unknown>,
): string | null {
  if (typeof data.link === 'string') return data.link;
  if (!entityId) return null;
  if (entityType === NOTIFICATION_ENTITY_TYPES.SALES_ORDER) {
    return `/orders/${entityId}`;
  }
  if (entityType === NOTIFICATION_ENTITY_TYPES.DELIVERY_TRIP) return '/transport';
  return null;
}
