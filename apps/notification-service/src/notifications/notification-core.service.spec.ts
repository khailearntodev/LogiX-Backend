import { NotificationCoreService } from './notification-core.service.js';
import { ChannelDispatcher } from '../channels/channel-dispatcher.js';

describe('NotificationCoreService', () => {
  it('dispatches in-app delivery through the channel boundary', async () => {
    const dispatcher = {
      deliver: vi.fn().mockResolvedValue({ status: 'EMITTED' }),
    } as unknown as ChannelDispatcher;
    const service = new NotificationCoreService(dispatcher);

    await expect(
      service.dispatchInApp({
        notificationId: 'notification-1',
        tenantId: 'tenant-1',
        recipientUserId: 'user-1',
        payload: { id: 'notification-1' },
      }),
    ).resolves.toEqual({ status: 'EMITTED' });

    expect(dispatcher.deliver).toHaveBeenCalledWith({
      notificationId: 'notification-1',
      tenantId: 'tenant-1',
      recipientUserId: 'user-1',
      channel: 'IN_APP',
      payload: { id: 'notification-1' },
    });
  });
});
