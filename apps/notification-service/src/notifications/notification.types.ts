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
