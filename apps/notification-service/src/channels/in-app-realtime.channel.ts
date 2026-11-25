import { Injectable } from '@nestjs/common';
import { NotificationsGateway } from '../realtime/notifications.gateway.js';
import {
  NOTIFICATION_CHANNELS,
  type NotificationChannel,
  type NotificationDeliveryContext,
  type NotificationDeliveryResult,
} from '../notifications/notification.types.js';

@Injectable()
export class InAppRealtimeChannel implements NotificationChannel {
  readonly channel = NOTIFICATION_CHANNELS.IN_APP;

  constructor(private readonly gateway: NotificationsGateway) {}

  async deliver(
    context: NotificationDeliveryContext,
  ): Promise<NotificationDeliveryResult> {
    this.gateway.emitNotification(
      context.tenantId,
      context.recipientUserId,
      context.payload,
    );
    if (typeof context.unreadCount === 'number') {
      this.gateway.emitUnreadCount(
        context.tenantId,
        context.recipientUserId,
        context.unreadCount,
      );
    }
    return { status: 'EMITTED' };
  }
}
