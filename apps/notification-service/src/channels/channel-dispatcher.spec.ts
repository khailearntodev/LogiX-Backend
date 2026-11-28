import { ChannelDispatcher } from './channel-dispatcher.js';
import {
  NOTIFICATION_CHANNELS,
  type NotificationChannel,
} from '../notifications/notification.types.js';

describe('ChannelDispatcher', () => {
  it('dispatches to a registered channel', async () => {
    const deliver = vi.fn().mockResolvedValue({ status: 'EMITTED' });
    const channel: NotificationChannel = {
      channel: NOTIFICATION_CHANNELS.IN_APP,
      deliver,
    };
    const dispatcher = new ChannelDispatcher();
    dispatcher.register(channel);

    await expect(
      dispatcher.deliver({
        notificationId: 'notification-1',
        tenantId: 'tenant-1',
        recipientUserId: 'user-1',
        channel: NOTIFICATION_CHANNELS.IN_APP,
        payload: { id: 'notification-1' },
      }),
    ).resolves.toEqual({ status: 'EMITTED' });
    expect(deliver).toHaveBeenCalledOnce();
  });

  it('fails when a channel is not configured', async () => {
    const dispatcher = new ChannelDispatcher();

    await expect(
      dispatcher.deliver({
        notificationId: 'notification-1',
        tenantId: 'tenant-1',
        recipientUserId: 'user-1',
        channel: NOTIFICATION_CHANNELS.EMAIL,
        payload: {},
      }),
    ).rejects.toThrow('Notification channel is not configured: EMAIL');
  });
});
