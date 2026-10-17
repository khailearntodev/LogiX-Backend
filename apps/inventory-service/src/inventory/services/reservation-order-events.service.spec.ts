import { Test } from '@nestjs/testing';
import { ServiceId } from '@logix/common';
import { PrismaService } from '../../database/prisma.service.js';
import { ReservationService } from './reservation.service.js';
import { ReservationOrderEventsService } from './reservation-order-events.service.js';

const event = {
  eventId: '00000000-0000-4000-8000-000000000010',
  tenantId: '00000000-0000-4000-8000-000000000011',
  eventType: 'OrderConfirmed',
  eventVersion: 1,
  producer: ServiceId.ORDER_SERVICE,
  actorId: null,
  correlationId: '00000000-0000-4000-8000-000000000012',
  causationId: '00000000-0000-4000-8000-000000000012',
  aggregateType: 'SalesOrder',
  aggregateId: '00000000-0000-4000-8000-000000000013',
  aggregateVersion: 2,
  occurredAt: new Date().toISOString(),
  payload: {
    orderId: '00000000-0000-4000-8000-000000000013',
    reservationGroupId: '00000000-0000-4000-8000-000000000014',
  },
};

async function setup() {
  const tx = {
    $queryRaw: vi.fn(),
    inboxEvent: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
    },
    reservationGroup: {
      findFirst: vi
        .fn()
        .mockResolvedValue({ id: event.payload.reservationGroupId }),
      update: vi.fn(),
    },
  };
  const reservations = { release: vi.fn() };
  const module = await Test.createTestingModule({
    providers: [
      ReservationOrderEventsService,
      {
        provide: PrismaService,
        useValue: {
          $transaction: (callback: (value: typeof tx) => Promise<void>) =>
            callback(tx),
        },
      },
      { provide: ReservationService, useValue: reservations },
    ],
  }).compile();
  return {
    service: module.get(ReservationOrderEventsService),
    tx,
    reservations,
  };
}

describe('ReservationOrderEventsService', () => {
  it('acknowledges only the tenant reservation and stores inbox in the same transaction', async () => {
    const { service, tx } = await setup();
    await service.handle(event);
    expect(tx.reservationGroup.findFirst).toHaveBeenCalledWith({
      where: {
        id: event.payload.reservationGroupId,
        tenantId: event.tenantId,
        orderId: event.payload.orderId,
      },
    });
    expect(tx.reservationGroup.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ acknowledgedAt: expect.any(Date) }),
      }),
    );
    expect(tx.inboxEvent.create).toHaveBeenCalledTimes(1);
  });

  it('does not acknowledge a duplicate confirmation twice', async () => {
    const { service, tx } = await setup();
    tx.inboxEvent.findUnique.mockResolvedValue({ id: 'processed' });
    await service.handle(event);
    expect(tx.reservationGroup.update).not.toHaveBeenCalled();
  });

  it('rejects unknown reservations and leaves the event unprocessed', async () => {
    const { service, tx } = await setup();
    tx.reservationGroup.findFirst.mockResolvedValue(null);
    await expect(service.handle(event)).rejects.toThrow('unknown reservation');
    expect(tx.inboxEvent.create).not.toHaveBeenCalled();
  });

  it('passes the cancel event identity to the atomic release/inbox transaction', async () => {
    const { service, reservations } = await setup();
    await service.handle({ ...event, eventType: 'OrderCanceled' });
    expect(reservations.release).toHaveBeenCalledWith(event.payload.orderId, {
      tenantId: event.tenantId,
      correlationId: event.correlationId,
      eventId: event.eventId,
    });
  });

  it('rejects a non-Order producer without releasing stock', async () => {
    const { service, reservations } = await setup();
    await expect(
      service.handle({
        ...event,
        eventType: 'OrderCanceled',
        producer: ServiceId.INVENTORY_SERVICE,
      }),
    ).rejects.toThrow('Unexpected order event producer');
    expect(reservations.release).not.toHaveBeenCalled();
  });
});
