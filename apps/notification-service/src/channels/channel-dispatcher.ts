import { Injectable } from '@nestjs/common';
import type {
  NotificationChannel,
  NotificationChannelName,
  NotificationDeliveryContext,
  NotificationDeliveryResult,
} from '../notifications/notification.types.js';

@Injectable()
export class ChannelDispatcher {
  private readonly channels = new Map<
    NotificationChannelName,
    NotificationChannel
  >();

  register(channel: NotificationChannel): void {
    if (this.channels.has(channel.channel)) {
      throw new Error(`Notification channel already registered: ${channel.channel}`);
    }
    this.channels.set(channel.channel, channel);
  }

  async deliver(
    context: NotificationDeliveryContext,
  ): Promise<NotificationDeliveryResult> {
    const channel = this.channels.get(context.channel);
    if (!channel) {
      throw new Error(`Notification channel is not configured: ${context.channel}`);
    }
    return channel.deliver(context);
  }
}
