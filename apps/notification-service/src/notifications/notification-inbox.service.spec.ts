import { EntityNotFoundError, ValidationError } from '@logix/errors';
import type { AuthenticatedUser } from '@logix/auth';
import { NotificationInboxService } from './notification-inbox.service.js';
import { ListNotificationsQueryDto } from './dto/list-notifications.dto.js';
import type { PrismaService } from '../database/prisma.service.js';
import type { NotificationsGateway } from '../realtime/notifications.gateway.js';

const USER: AuthenticatedUser = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'user@example.com',
  tenantId: '22222222-2222-4222-8222-222222222222',
};

const NOTIFICATION_ID = '33333333-3333-4333-8333-333333333333';

describe('NotificationInboxService', () => {
  const prisma = {
    notification: { findMany: vi.fn() },
    notificationRecipient: {
      count: vi.fn(),
    },
    $transaction: vi.fn(),
  } as unknown as PrismaService & {
    notificationRecipient: {
      count: ReturnType<typeof vi.fn>;
    };
  };
  const transaction = {
    notificationRecipient: {
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  };
  const gateway = {
    emitUnreadCount: vi.fn(),
  } as unknown as NotificationsGateway & {
    emitUnreadCount: ReturnType<typeof vi.fn>;
  };

  let service: NotificationInboxService;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.$transaction).mockImplementation(async (callback) =>
      callback(transaction as never),
    );
    service = new NotificationInboxService(prisma, gateway);
  });

  it('lists only the current user inbox and returns a keyset cursor', async () => {
    const query = new ListNotificationsQueryDto();
    query.limit = 1;
    const createdAt = new Date('2026-01-01T00:00:00.000Z');
    vi.mocked(prisma.notification.findMany).mockResolvedValue([
      {
        id: NOTIFICATION_ID,
        type: 'ORDER_PENDING_STOCK',
        severity: 'WARNING',
        title: 'Thiếu tồn kho',
        body: 'Đơn hàng đang thiếu tồn kho',
        entityType: 'SalesOrder',
        entityId: '44444444-4444-4444-8444-444444444444',
        data: { link: '/orders/order-1', source: 'event' },
        createdAt,
        recipients: [
          {
            readAt: null,
            archivedAt: null,
          },
        ],
      },
      {
        id: '55555555-5555-4555-8555-555555555555',
        type: 'DELIVERY_FAILED',
        severity: 'CRITICAL',
        title: 'Giao thất bại',
        body: 'Giao hàng thất bại',
        entityType: 'DeliveryTrip',
        entityId: '66666666-6666-4666-8666-666666666666',
        data: {},
        createdAt: new Date('2025-12-31T00:00:00.000Z'),
        recipients: [
          {
            readAt: new Date('2026-01-02T00:00:00.000Z'),
            archivedAt: null,
          },
        ],
      },
    ] as never);

    const result = await service.list(USER, query);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      id: NOTIFICATION_ID,
      link: '/orders/order-1',
      data: { link: '/orders/order-1', source: 'event' },
      readAt: null,
      archivedAt: null,
    });
    expect(result.nextCursor).toEqual(expect.any(String));
    expect(prisma.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 2,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        where: expect.objectContaining({
          tenantId: USER.tenantId,
          recipients: {
            some: expect.objectContaining({
              tenantId: USER.tenantId,
              recipientId: USER.id,
              recipientType: 'USER',
              archivedAt: null,
              deletedAt: null,
            }),
          },
        }),
      }),
    );
  });

  it('rejects malformed cursors before querying the database', async () => {
    const query = new ListNotificationsQueryDto();
    query.cursor = 'invalid cursor';

    await expect(service.list(USER, query)).rejects.toBeInstanceOf(ValidationError);
    expect(prisma.notification.findMany).not.toHaveBeenCalled();
  });

  it('counts unread notifications within the current tenant and user', async () => {
    prisma.notificationRecipient.count.mockResolvedValue(4);

    await expect(service.unreadCount(USER)).resolves.toEqual({ count: 4 });
    expect(prisma.notificationRecipient.count).toHaveBeenCalledWith({
      where: {
        tenantId: USER.tenantId,
        recipientType: 'USER',
        recipientId: USER.id,
        readAt: null,
        archivedAt: null,
        deletedAt: null,
        notification: { tenantId: USER.tenantId, deletedAt: null },
      },
    });
  });

  it('marks a notification read and publishes the updated unread count', async () => {
    transaction.notificationRecipient.findFirst.mockResolvedValue({
      id: '77777777-7777-4777-8777-777777777777',
      readAt: null,
      archivedAt: null,
    });
    transaction.notificationRecipient.update.mockResolvedValue({});
    prisma.notificationRecipient.count.mockResolvedValue(2);

    await service.markRead(USER, NOTIFICATION_ID);

    expect(transaction.notificationRecipient.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: '77777777-7777-4777-8777-777777777777' },
        data: { readAt: expect.any(Date), version: { increment: 1 } },
      }),
    );
    expect(gateway.emitUnreadCount).toHaveBeenCalledWith(
      USER.tenantId,
      USER.id,
      2,
    );
  });

  it('returns not found for a notification outside the user tenant', async () => {
    transaction.notificationRecipient.findFirst.mockResolvedValue(null);

    await expect(service.markRead(USER, NOTIFICATION_ID)).rejects.toBeInstanceOf(
      EntityNotFoundError,
    );
    expect(transaction.notificationRecipient.update).not.toHaveBeenCalled();
    expect(gateway.emitUnreadCount).not.toHaveBeenCalled();
  });

  it('marks all active unread notifications read and returns the update count', async () => {
    transaction.notificationRecipient.updateMany.mockResolvedValue({ count: 3 });
    prisma.notificationRecipient.count.mockResolvedValue(0);

    await expect(service.markAllRead(USER)).resolves.toEqual({ updated: 3 });
    expect(transaction.notificationRecipient.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        tenantId: USER.tenantId,
        recipientId: USER.id,
        readAt: null,
        archivedAt: null,
        deletedAt: null,
      }),
      data: { readAt: expect.any(Date), version: { increment: 1 } },
    });
    expect(gateway.emitUnreadCount).toHaveBeenCalledWith(USER.tenantId, USER.id, 0);
  });

  it('keeps archive idempotent while synchronizing unread count', async () => {
    transaction.notificationRecipient.findFirst.mockResolvedValue({
      id: '88888888-8888-4888-8888-888888888888',
      readAt: new Date('2026-01-01T00:00:00.000Z'),
      archivedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    prisma.notificationRecipient.count.mockResolvedValue(1);

    await service.archive(USER, NOTIFICATION_ID);

    expect(transaction.notificationRecipient.update).not.toHaveBeenCalled();
    expect(gateway.emitUnreadCount).toHaveBeenCalledWith(USER.tenantId, USER.id, 1);
  });
});
