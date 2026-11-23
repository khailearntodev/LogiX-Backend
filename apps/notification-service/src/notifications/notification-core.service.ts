import { Injectable } from '@nestjs/common';
import { ChannelDispatcher } from '../channels/channel-dispatcher.js';
import {
  NOTIFICATION_CHANNELS,
  type NotificationDeliveryContext,
  type NotificationDeliveryResult,
} from './notification.types.js';

@Injectable()
export class NotificationCoreService {
  constructor(private readonly dispatcher: ChannelDispatcher) {}

  dispatchInApp(
    context: Omit<NotificationDeliveryContext, 'channel'>,
  ): Promise<NotificationDeliveryResult> {
    return this.dispatcher.deliver({
      ...context,
      channel: NOTIFICATION_CHANNELS.IN_APP,
    });
  }
}
