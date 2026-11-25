import { Module } from '@nestjs/common';
import { ChannelDispatcher } from './channel-dispatcher.js';
import { InAppRealtimeChannel } from './in-app-realtime.channel.js';
import { NotificationsGateway } from '../realtime/notifications.gateway.js';

@Module({
  providers: [
    NotificationsGateway,
    InAppRealtimeChannel,
    {
      provide: ChannelDispatcher,
      inject: [InAppRealtimeChannel],
      useFactory: (inApp: InAppRealtimeChannel) => {
        const dispatcher = new ChannelDispatcher();
        dispatcher.register(inApp);
        return dispatcher;
      },
    },
  ],
  exports: [NotificationsGateway, ChannelDispatcher, InAppRealtimeChannel],
})
export class ChannelsModule {}
