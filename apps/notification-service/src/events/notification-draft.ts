import type {
  NotificationEntityType,
  NotificationSeverity,
  NotificationType,
} from '../notifications/notification.constants.js';

export type NotificationAudience =
  | { kind: 'ALL' }
  | { kind: 'ROLES'; roleIds: string[] }
  | { kind: 'USERS'; userIds: string[] }
  | { kind: 'PERMISSION'; code: string };

export interface NotificationDraft {
  type: NotificationType;
  title: string;
  body: string;
  link: string | null;
  severity: NotificationSeverity;
  entityType: NotificationEntityType | null;
  entityId: string | null;
  deduplicationKey: string;
  data: Record<string, unknown>;
  audience: NotificationAudience;
}
