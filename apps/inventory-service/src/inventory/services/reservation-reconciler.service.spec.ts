import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../database/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import { ReservationService } from './reservation.service.js';
import { ReservationReconcilerService } from './reservation-reconciler.service.js';

const group = {
  id: '00000000-0000-4000-8000-000000000010',
  tenantId: '00000000-0000-4000-8000-000000000011',
  orderId: '00000000-0000-4000-8000-000000000012',
  warehouseId: '00000000-0000-4000-8000-000000000013',
  orderVersion: 1n,
  reservations: [
    {
      orderLineId: '00000000-0000-4000-8000-000000000014',
      productId: '00000000-0000-4000-8000-000000000015',
      quantity: new Prisma.Decimal('10'),
    },
  ],
};

async function setup() {
  const prisma = {
    reservationGroup: {
      findMany: vi.fn().mockResolvedValue([group]),
      updateMany: vi.fn(),
    },
  };
  const reservations = { release: vi.fn() };
  const config = new ConfigService({
    RESERVATION_RECONCILE_AGE_MS: 300000,
    OUTBOX_BATCH_SIZE: 20,
    INTERNAL_SERVICE_JWT_SECRET: 'test-only-internal-secret-with-32-characters',
    ORDER_SERVICE_URL: 'http://order.test',
  });
  const module = await Test.createTestingModule({
    providers: [
      ReservationReconcilerService,
      { provide: PrismaService, useValue: prisma },
      { provide: ReservationService, useValue: reservations },
      { provide: ConfigService, useValue: config },
    ],
  }).compile();
  return {
    service: module.get(ReservationReconcilerService),
    reservations,
    prisma,
  };
}

describe('ReservationReconcilerService', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(['KEEP', 'ACKNOWLEDGE'])(
    'never releases stock on an Order %s decision',
    async (decision) => {
      const { service, reservations, prisma } = await setup();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(new Response(JSON.stringify({ decision }))),
      );
      await service.reconcile();
      expect(reservations.release).not.toHaveBeenCalled();
      expect(prisma.reservationGroup.updateMany).toHaveBeenCalledTimes(
        decision === 'ACKNOWLEDGE' ? 1 : 0,
      );
    },
  );

  it('releases only the explicitly unused reservation group', async () => {
    const { service, reservations } = await setup();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{"decision":"RELEASE"}')),
    );
    await service.reconcile();
    expect(reservations.release).toHaveBeenCalledWith(
      group.orderId,
      expect.objectContaining({ tenantId: group.tenantId }),
      group.id,
    );
  });

  it.each([
    new Response('{}', { status: 503 }),
    new Response('{"decision":"UNKNOWN"}'),
    new Response('invalid-json'),
  ])('keeps stock on invalid/unavailable Order response', async (response) => {
    const { service, reservations, prisma } = await setup();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    await service.reconcile();
    expect(reservations.release).not.toHaveBeenCalled();
    expect(prisma.reservationGroup.updateMany).not.toHaveBeenCalled();
  });

  it('keeps stock on timeout/connection failure', async () => {
    const { service, reservations } = await setup();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('connection timeout')),
    );
    await service.reconcile();
    expect(reservations.release).not.toHaveBeenCalled();
  });
});
