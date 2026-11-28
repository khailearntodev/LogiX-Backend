export const NOTIFICATION_CHANNELS = {
  IN_APP: 'IN_APP',
  EMAIL: 'EMAIL',
  PUSH: 'PUSH',
} as const;

export type NotificationChannelName =
  (typeof NOTIFICATION_CHANNELS)[keyof typeof NOTIFICATION_CHANNELS];

export interface NotificationDeliveryContext {
  notificationId: string;
  tenantId: string;
  recipientUserId: string;
  channel: NotificationChannelName;
  payload: Record<string, unknown>;
  unreadCount?: number;
}

export interface NotificationDeliveryResult {
  status: 'EMITTED' | 'SKIPPED';
}

export interface NotificationChannel {
  readonly channel: NotificationChannelName;
  deliver(
    context: NotificationDeliveryContext,
  ): Promise<NotificationDeliveryResult>;
}

export interface NotificationItemDto {
  id: string;
  type: string;
  severity: string;
  title: string;
  body: string;
  entityType: string | null;
  entityId: string | null;
  link: string | null;
  data: Record<string, unknown>;
  createdAt: string;
  readAt: string | null;
  archivedAt: string | null;
}
