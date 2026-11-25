import { InAppRealtimeChannel } from './in-app-realtime.channel.js';
import type { NotificationsGateway } from '../realtime/notifications.gateway.js';

describe('InAppRealtimeChannel', () => {
  it('emits notification.created and unread-count when unreadCount is provided', async () => {
    const gateway = {
      emitNotification: vi.fn(),
      emitUnreadCount: vi.fn(),
    } as unknown as NotificationsGateway;
    const channel = new InAppRealtimeChannel(gateway);

    await expect(
      channel.deliver({
        notificationId: 'notif-1',
        tenantId: 'tenant-1',
        recipientUserId: 'user-1',
        channel: 'IN_APP',
        payload: { id: 'notif-1' },
        unreadCount: 3,
      }),
    ).resolves.toEqual({ status: 'EMITTED' });

    expect(gateway.emitNotification).toHaveBeenCalledWith('tenant-1', 'user-1', {
      id: 'notif-1',
    });
    expect(gateway.emitUnreadCount).toHaveBeenCalledWith('tenant-1', 'user-1', 3);
  });

  it('skips unread-count emission when unreadCount is omitted', async () => {
    const gateway = {
      emitNotification: vi.fn(),
      emitUnreadCount: vi.fn(),
    } as unknown as NotificationsGateway;
    const channel = new InAppRealtimeChannel(gateway);

    await channel.deliver({
      notificationId: 'notif-1',
      tenantId: 'tenant-1',
      recipientUserId: 'user-1',
      channel: 'IN_APP',
      payload: { id: 'notif-1' },
    });

    expect(gateway.emitNotification).toHaveBeenCalledOnce();
    expect(gateway.emitUnreadCount).not.toHaveBeenCalled();
  });
});
