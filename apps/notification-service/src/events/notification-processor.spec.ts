import { randomUUID } from 'node:crypto';
import type { DomainEventEnvelope } from '@logix/messaging';
import { Prisma } from '../generated/prisma/client.js';
import { NotificationProcessor } from './notification-processor.js';
import * as eventBuilders from './event-builders.js';
import { IdentityRecipientClient } from '../integrations/identity-recipient.client.js';
import { NotificationCoreService } from '../notifications/notification-core.service.js';

const id = () => randomUUID();

function validOrderPendingEvent(): DomainEventEnvelope {
  const orderId = id();
  return {
    eventId: id(),
    eventType: 'OrderPendingStock',
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
    producer: 'order-service',
    tenantId: id(),
    actorId: null,
    correlationId: id(),
    causationId: id(),
    aggregateType: 'SalesOrder',
    aggregateId: orderId,
    aggregateVersion: 2,
    payload: {
      orderId,
      warehouseId: id(),
      pendingSince: new Date().toISOString(),
      shortageItems: [
        {
          productId: id(),
          requestedQuantity: '5',
          availableQuantity: '2',
        },
      ],
    },
  };
}

describe('NotificationProcessor', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns IGNORED for unsupported events without calling DB or identity service', async () => {
    const prisma = { inboxEvent: { findUnique: vi.fn() } } as never;
    const recipients = { resolve: vi.fn() } as unknown as IdentityRecipientClient;
    const core = { dispatchInApp: vi.fn() } as unknown as NotificationCoreService;
    const processor = new NotificationProcessor(prisma, recipients, core);

    const event: DomainEventEnvelope = {
      ...validOrderPendingEvent(),
      eventType: 'OrderCreated',
    };

    await expect(processor.handle(event)).resolves.toEqual({ outcome: 'IGNORED' });
    expect(recipients.resolve).not.toHaveBeenCalled();
    expect(core.dispatchInApp).not.toHaveBeenCalled();
  });

  it('records invalid supported events without retrying them', async () => {
    const inboxEvent = { upsert: vi.fn().mockResolvedValue({}) };
    const prisma = { inboxEvent } as never;
    const recipients = {} as IdentityRecipientClient;
    const core = {} as NotificationCoreService;
    const processor = new NotificationProcessor(prisma, recipients, core);

    const invalidEvent: DomainEventEnvelope = {
      ...validOrderPendingEvent(),
      payload: {},
    };

    await expect(processor.handle(invalidEvent)).resolves.toEqual({
      outcome: 'REJECTED_INVALID',
    });
    expect(inboxEvent.upsert).toHaveBeenCalledOnce();
  });

  it('rethrows unexpected non-validation errors from buildNotificationDraft instead of recording REJECTED_INVALID', async () => {
    vi.spyOn(eventBuilders, 'buildNotificationDraft').mockImplementation(() => {
      throw new TypeError('Unexpected runtime bug');
    });
    const inboxEvent = { upsert: vi.fn() };
    const prisma = { inboxEvent } as never;
    const recipients = {} as IdentityRecipientClient;
    const core = {} as NotificationCoreService;
    const processor = new NotificationProcessor(prisma, recipients, core);

    await expect(processor.handle(validOrderPendingEvent())).rejects.toThrow(
      'Unexpected runtime bug',
    );
    expect(inboxEvent.upsert).not.toHaveBeenCalled();
  });

  it('records REJECTED_INVALID when buildNotificationDraft throws InvalidNotificationEventError', async () => {
    vi.spyOn(eventBuilders, 'buildNotificationDraft').mockImplementation(() => {
      throw new eventBuilders.InvalidNotificationEventError('Invalid ids');
    });
    const inboxEvent = { upsert: vi.fn().mockResolvedValue({}) };
    const prisma = { inboxEvent } as never;
    const recipients = {} as IdentityRecipientClient;
    const core = {} as NotificationCoreService;
    const processor = new NotificationProcessor(prisma, recipients, core);

    await expect(processor.handle(validOrderPendingEvent())).resolves.toEqual({
      outcome: 'REJECTED_INVALID',
    });
    expect(inboxEvent.upsert).toHaveBeenCalledOnce();
  });

  it('skips inbox persistence safely when invalid event has unsafe aggregateVersion', async () => {
    const inboxEvent = { upsert: vi.fn() };
    const prisma = { inboxEvent } as never;
    const recipients = {} as IdentityRecipientClient;
    const core = {} as NotificationCoreService;
    const processor = new NotificationProcessor(prisma, recipients, core);

    const invalidEvent = {
      ...validOrderPendingEvent(),
      aggregateVersion: Number.NaN,
      payload: {},
    } as DomainEventEnvelope;

    await expect(processor.handle(invalidEvent)).resolves.toEqual({
      outcome: 'REJECTED_INVALID',
    });
    expect(inboxEvent.upsert).not.toHaveBeenCalled();
  });

  it('short-circuits DUPLICATE events before calling identity service', async () => {
    const inboxEvent = { findUnique: vi.fn().mockResolvedValue({ id: id() }) };
    const prisma = { inboxEvent, $transaction: vi.fn() } as never;
    const recipients = { resolve: vi.fn() } as unknown as IdentityRecipientClient;
    const core = { dispatchInApp: vi.fn() } as unknown as NotificationCoreService;
    const processor = new NotificationProcessor(prisma, recipients, core);

    await expect(processor.handle(validOrderPendingEvent())).resolves.toEqual({
      outcome: 'DUPLICATE',
    });
    expect(recipients.resolve).not.toHaveBeenCalled();
    expect(core.dispatchInApp).not.toHaveBeenCalled();
  });

  it('records NO_RECIPIENTS and does not emit realtime notifications', async () => {
    const txInboxCreate = vi.fn().mockResolvedValue({});
    const prisma = {
      inboxEvent: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
        cb({
          inboxEvent: {
            findUnique: vi.fn().mockResolvedValue(null),
            create: txInboxCreate,
          },
        }),
      ),
    } as never;
    const recipients = {
      resolve: vi.fn().mockResolvedValue([]),
    } as unknown as IdentityRecipientClient;
    const core = { dispatchInApp: vi.fn() } as unknown as NotificationCoreService;
    const processor = new NotificationProcessor(prisma, recipients, core);

    await expect(processor.handle(validOrderPendingEvent())).resolves.toEqual({
      outcome: 'NO_RECIPIENTS',
      recipientUserIds: [],
    });
    expect(txInboxCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ outcome: 'NO_RECIPIENTS' }),
      }),
    );
    expect(core.dispatchInApp).not.toHaveBeenCalled();
  });

  it('persists notification, queries unread counts, and dispatches WS after commit even if one WS emit fails', async () => {
    const createdAt = new Date('2026-11-25T09:00:00.000Z');
    const userA = id();
    const userB = id();
    const event = validOrderPendingEvent();

    const tx = {
      inboxEvent: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
      },
      notification: {
        create: vi.fn().mockImplementation(async ({ data }: { data: { id: string } }) => ({
          id: data.id,
          createdAt,
        })),
      },
      notificationRecipient: { createMany: vi.fn().mockResolvedValue({ count: 2 }) },
      notificationDelivery: { createMany: vi.fn().mockResolvedValue({ count: 2 }) },
    };

    const prisma = {
      inboxEvent: { findUnique: vi.fn().mockResolvedValue(null) },
      notificationRecipient: {
        groupBy: vi.fn().mockResolvedValue([
          { recipientId: userA, _count: { _all: 4 } },
          { recipientId: userB, _count: { _all: 1 } },
        ]),
      },
      $transaction: vi.fn(async (cb: (client: unknown) => Promise<unknown>) => cb(tx)),
    } as never;

    const recipients = {
      resolve: vi.fn().mockResolvedValue([userA, userB]),
    } as unknown as IdentityRecipientClient;
    const dispatchInApp = vi
      .fn()
      .mockRejectedValueOnce(new Error('socket down'))
      .mockResolvedValueOnce({ status: 'EMITTED' });
    const core = { dispatchInApp } as unknown as NotificationCoreService;

    const processor = new NotificationProcessor(prisma, recipients, core);
    const result = await processor.handle(event);

    expect(result).toMatchObject({
      outcome: 'APPLIED',
      recipientUserIds: [userA, userB],
    });
    expect(result.notificationId).toBeTruthy();
    expect(dispatchInApp).toHaveBeenCalledTimes(2);
    expect(dispatchInApp).toHaveBeenNthCalledWith(1, {
      notificationId: result.notificationId,
      tenantId: event.tenantId,
      recipientUserId: userA,
      unreadCount: 4,
      payload: expect.objectContaining({
        id: result.notificationId,
        createdAt: createdAt.toISOString(),
        link: `/orders/${event.aggregateId}`,
        readAt: null,
        archivedAt: null,
      }),
    });
    expect(dispatchInApp).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        recipientUserId: userB,
        unreadCount: 1,
      }),
    );
  });

  it('records DUPLICATE when transaction hits P2002 on deduplication or inbox constraint', async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError('Unique violation', {
      code: 'P2002',
      clientVersion: '7.10.0',
      meta: { target: 'ux_notification_event_recipient_scope' },
    });
    const inboxUpsert = vi.fn().mockResolvedValue({});
    const prisma = {
      inboxEvent: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: inboxUpsert,
      },
      $transaction: vi.fn().mockRejectedValue(p2002),
    } as never;
    const recipients = {
      resolve: vi.fn().mockResolvedValue([id()]),
    } as unknown as IdentityRecipientClient;
    const core = { dispatchInApp: vi.fn() } as unknown as NotificationCoreService;
    const processor = new NotificationProcessor(prisma, recipients, core);

    await expect(processor.handle(validOrderPendingEvent())).resolves.toEqual({
      outcome: 'DUPLICATE',
      recipientUserIds: expect.any(Array),
    });
    expect(inboxUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          outcome: 'DUPLICATE',
          errorCode: 'DUPLICATE_EVENT',
        }),
      }),
    );
    expect(core.dispatchInApp).not.toHaveBeenCalled();
  });

  it('records DUPLICATE when P2002 targets inbox consumer_name and event_id fields', async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError('Unique violation', {
      code: 'P2002',
      clientVersion: '7.10.0',
      meta: { target: ['consumer_name', 'event_id'] },
    });
    const inboxUpsert = vi.fn().mockResolvedValue({});
    const prisma = {
      inboxEvent: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: inboxUpsert,
      },
      $transaction: vi.fn().mockRejectedValue(p2002),
    } as never;
    const recipients = {
      resolve: vi.fn().mockResolvedValue([id()]),
    } as unknown as IdentityRecipientClient;
    const core = { dispatchInApp: vi.fn() } as unknown as NotificationCoreService;
    const processor = new NotificationProcessor(prisma, recipients, core);

    await expect(processor.handle(validOrderPendingEvent())).resolves.toEqual({
      outcome: 'DUPLICATE',
      recipientUserIds: expect.any(Array),
    });
    expect(inboxUpsert).toHaveBeenCalledOnce();
  });

  it('rethrows P2002 when it targets a non-duplicate constraint', async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError('Unique violation', {
      code: 'P2002',
      clientVersion: '7.10.0',
      meta: { target: 'ux_delivery_channel' },
    });
    const inboxUpsert = vi.fn();
    const prisma = {
      inboxEvent: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: inboxUpsert,
      },
      $transaction: vi.fn().mockRejectedValue(p2002),
    } as never;
    const recipients = {
      resolve: vi.fn().mockResolvedValue([id()]),
    } as unknown as IdentityRecipientClient;
    const core = { dispatchInApp: vi.fn() } as unknown as NotificationCoreService;
    const processor = new NotificationProcessor(prisma, recipients, core);

    await expect(processor.handle(validOrderPendingEvent())).rejects.toThrow(
      'Unique violation',
    );
    expect(inboxUpsert).not.toHaveBeenCalled();
  });

  it('propagates transient errors from IdentityRecipientClient so Kafka retains offset', async () => {
    const prisma = {
      inboxEvent: { findUnique: vi.fn().mockResolvedValue(null) },
    } as never;
    const recipients = {
      resolve: vi.fn().mockRejectedValue(new Error('Identity service 503')),
    } as unknown as IdentityRecipientClient;
    const core = { dispatchInApp: vi.fn() } as unknown as NotificationCoreService;
    const processor = new NotificationProcessor(prisma, recipients, core);

    await expect(processor.handle(validOrderPendingEvent())).rejects.toThrow(
      'Identity service 503',
    );
  });
});
