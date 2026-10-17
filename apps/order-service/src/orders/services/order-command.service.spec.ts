import { Prisma } from '../../generated/prisma/client.js';
import type { PrismaService } from '../../database/prisma.service.js';
import {
  ADDRESS_ID,
  CUSTOMER_ID,
  ORDER_ID,
  PRODUCT_A_ID,
  PRODUCT_B_ID,
  TENANT_ID,
  WAREHOUSE_ID,
  commandContext,
  salesOrderFixture,
} from '../../../test/fixtures/order.fixtures.js';
import { ORDER_EVENT } from '../domain/order-constants.js';
import { OrderErrors, ORDER_ERROR_REASON } from '../domain/order-errors.js';
import type { CreateOrderDto } from '../dto/create-order.dto.js';
import type { OrderOutboxWriter } from '../outbox/order-outbox.writer.js';
import {
  OrderCommandService,
  hashCreateOrderRequest,
} from './order-command.service.js';
import type { OrderNumberService } from './order-number.service.js';
import type { InventoryClient } from '../integrations/inventory.client.js';
import type {
  OrderReferenceResolver,
  ResolvedOrderLine,
} from './order-reference.resolver.js';

const IDEMPOTENCY_KEY = 'create-order-0001';

const createDto = (
  overrides: Partial<CreateOrderDto> = {},
): CreateOrderDto => ({
  customerId: CUSTOMER_ID,
  deliveryAddressId: ADDRESS_ID,
  warehouseId: WAREHOUSE_ID,
  currency: 'VND',
  lines: [{ productId: PRODUCT_A_ID, quantity: '10' }],
  ...overrides,
});

const resolvedLine: ResolvedOrderLine = {
  lineNumber: 1,
  productId: PRODUCT_A_ID,
  skuSnapshot: 'SKU-A',
  productNameSnapshot: 'Sản phẩm A',
  unitSnapshot: 'PCS',
  quantity: new Prisma.Decimal('10'),
  unitWeight: new Prisma.Decimal('1'),
  unitVolume: new Prisma.Decimal('0.01'),
};

const uniqueViolation = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });

const setup = () => {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    salesOrder: {
      create: vi.fn(),
      findFirst: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn().mockResolvedValue({}),
    },
    orderLine: {
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    orderStatusHistory: { create: vi.fn() },
    orderShortage: { updateMany: vi.fn() },
  };
  const prisma = {
    salesOrder: { findFirst: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) =>
      fn(tx),
    ),
  };
  const references = {
    assertLineRules: vi.fn(),
    resolveCustomer: vi.fn().mockResolvedValue({
      customerSnapshot: { customerId: CUSTOMER_ID, customerVersion: 3 },
      deliveryAddressSnapshot: { addressId: ADDRESS_ID, addressVersion: 2 },
    }),
    resolveWarehouse: vi
      .fn()
      .mockResolvedValue({ warehouseId: WAREHOUSE_ID, warehouseVersion: 1 }),
    resolveLines: vi.fn().mockResolvedValue([resolvedLine]),
  };
  const orderNumbers = {
    next: vi.fn().mockResolvedValue('SO-20250310-000001'),
  };
  const outbox = { write: vi.fn() };
  const inventory = {
    active: vi.fn().mockResolvedValue({ reservationGroupId: null }),
    release: vi.fn().mockResolvedValue({ outcome: 'RELEASED' }),
  };

  const service = new OrderCommandService(
    prisma as unknown as PrismaService,
    references as unknown as OrderReferenceResolver,
    orderNumbers as unknown as OrderNumberService,
    outbox as unknown as OrderOutboxWriter,
    inventory as unknown as InventoryClient,
  );
  return { service, prisma, tx, references, orderNumbers, outbox, inventory };
};

describe('hashCreateOrderRequest', () => {
  it('is stable across casing and equivalent quantity formats', () => {
    const a = createDto({
      lines: [{ productId: PRODUCT_A_ID, quantity: '10.000' }],
    });
    const b = createDto({
      customerId: CUSTOMER_ID.toUpperCase(),
      lines: [{ productId: PRODUCT_A_ID.toUpperCase(), quantity: '10' }],
    });

    expect(hashCreateOrderRequest(a)).toBe(hashCreateOrderRequest(b));
  });

  it('changes when the business content changes', () => {
    expect(hashCreateOrderRequest(createDto())).not.toBe(
      hashCreateOrderRequest(
        createDto({ lines: [{ productId: PRODUCT_A_ID, quantity: '11' }] }),
      ),
    );
  });
});

describe('OrderCommandService.create', () => {
  it('requires a well-formed Idempotency-Key before touching anything', async () => {
    const { service, prisma } = setup();

    for (const key of [undefined, 'short', 'has space in key']) {
      await expect(
        service.create(createDto(), key, commandContext),
      ).rejects.toMatchObject({
        reason: ORDER_ERROR_REASON.IDEMPOTENCY_KEY_REQUIRED,
        httpStatus: 400,
      });
    }
    expect(prisma.salesOrder.findFirst).not.toHaveBeenCalled();
  });

  it('creates a DRAFT order with history and OrderCreated outbox in one transaction', async () => {
    const { service, tx, outbox } = setup();
    const created = salesOrderFixture();
    tx.salesOrder.create.mockResolvedValue(created);

    const result = await service.create(
      createDto(),
      IDEMPOTENCY_KEY,
      commandContext,
    );

    expect(result.replayed).toBe(false);
    expect(result.order.orderNumber).toBe('SO-20250310-000001');
    const createArgs = tx.salesOrder.create.mock.calls[0]?.[0];
    expect(createArgs.data).toMatchObject({
      tenantId: TENANT_ID,
      status: 'DRAFT',
      orderSource: 'MANUAL',
      idempotencyKey: IDEMPOTENCY_KEY,
      idempotencyRequestHash: hashCreateOrderRequest(createDto()),
    });
    expect(createArgs.data.totalWeight.toString()).toBe('10');
    expect(createArgs.data.lines.create[0]).toMatchObject({
      tenantId: TENANT_ID,
      lineNumber: 1,
    });
    expect(tx.orderStatusHistory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        fromStatus: null,
        toStatus: 'DRAFT',
        actorId: commandContext.actorId,
      }),
    });
    expect(outbox.write).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        eventType: ORDER_EVENT.CREATED,
        orderId: ORDER_ID,
      }),
    );
  });

  it('replays the stored order for the same key and body', async () => {
    const { service, prisma, references } = setup();
    prisma.salesOrder.findFirst.mockResolvedValue(
      salesOrderFixture({
        idempotencyRequestHash: hashCreateOrderRequest(createDto()),
      }),
    );

    const result = await service.create(
      createDto(),
      IDEMPOTENCY_KEY,
      commandContext,
    );

    expect(result.replayed).toBe(true);
    expect(references.resolveCustomer).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects the same key with a different body', async () => {
    const { service, prisma } = setup();
    prisma.salesOrder.findFirst.mockResolvedValue(
      salesOrderFixture({ idempotencyRequestHash: 'another-request' }),
    );

    await expect(
      service.create(createDto(), IDEMPOTENCY_KEY, commandContext),
    ).rejects.toMatchObject({
      reason: ORDER_ERROR_REASON.IDEMPOTENCY_KEY_REUSED,
      httpStatus: 409,
    });
  });

  it('replays the winner when a concurrent request commits first', async () => {
    const { service, prisma } = setup();
    prisma.$transaction.mockRejectedValueOnce(uniqueViolation());
    prisma.salesOrder.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(
        salesOrderFixture({
          idempotencyRequestHash: hashCreateOrderRequest(createDto()),
        }),
      );

    const result = await service.create(
      createDto(),
      IDEMPOTENCY_KEY,
      commandContext,
    );

    expect(result.replayed).toBe(true);
  });

  it('does not write anything when Master Data is unavailable', async () => {
    const { service, prisma, references } = setup();
    references.resolveLines.mockRejectedValue(
      OrderErrors.upstreamUnavailable('master-data-service'),
    );

    await expect(
      service.create(createDto(), IDEMPOTENCY_KEY, commandContext),
    ).rejects.toMatchObject({
      httpStatus: 503,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('OrderCommandService.update', () => {
  it('rejects requests without changes', async () => {
    const { service } = setup();

    await expect(
      service.update(ORDER_ID, { version: 1 }, commandContext),
    ).rejects.toMatchObject({
      reason: ORDER_ERROR_REASON.NO_CHANGES,
    });
  });

  it('returns 404 for orders outside the tenant', async () => {
    const { service } = setup();

    await expect(
      service.update(ORDER_ID, { version: 1, currency: 'USD' }, commandContext),
    ).rejects.toMatchObject({
      reason: ORDER_ERROR_REASON.NOT_FOUND,
      httpStatus: 404,
    });
  });

  it('rejects stale versions with 409', async () => {
    const { service, prisma } = setup();
    prisma.salesOrder.findFirst.mockResolvedValue(
      salesOrderFixture({ version: 2n }),
    );

    await expect(
      service.update(ORDER_ID, { version: 1, currency: 'USD' }, commandContext),
    ).rejects.toMatchObject({
      reason: ORDER_ERROR_REASON.VERSION_CONFLICT,
      httpStatus: 409,
      details: expect.objectContaining({
        expectedVersion: 1,
        actualVersion: 2,
      }),
    });
  });

  it('rejects edits of non-DRAFT orders with INVALID_STATE_TRANSITION 409', async () => {
    const { service, prisma } = setup();
    prisma.salesOrder.findFirst.mockResolvedValue(
      salesOrderFixture({ status: 'CANCELED' }),
    );

    await expect(
      service.update(ORDER_ID, { version: 1, currency: 'USD' }, commandContext),
    ).rejects.toMatchObject({
      reason: ORDER_ERROR_REASON.INVALID_TRANSITION,
      code: 'INVALID_STATE_TRANSITION',
      httpStatus: 409,
    });
  });

  it('detects a concurrent writer through the guarded update', async () => {
    const { service, prisma, tx } = setup();
    prisma.salesOrder.findFirst.mockResolvedValue(salesOrderFixture());
    tx.salesOrder.updateMany.mockResolvedValue({ count: 0 });
    tx.salesOrder.findFirst.mockResolvedValue(
      salesOrderFixture({ version: 2n }),
    );

    await expect(
      service.update(ORDER_ID, { version: 1, currency: 'USD' }, commandContext),
    ).rejects.toMatchObject({ reason: ORDER_ERROR_REASON.VERSION_CONFLICT });
    expect(tx.orderLine.deleteMany).not.toHaveBeenCalled();
  });

  it('replaces lines, recalculates totals and writes OrderUpdated without history', async () => {
    const { service, prisma, tx, references, outbox } = setup();
    prisma.salesOrder.findFirst.mockResolvedValue(salesOrderFixture());
    tx.salesOrder.findFirst
      .mockResolvedValueOnce(salesOrderFixture())
      .mockResolvedValue(salesOrderFixture({ version: 2n }));
    references.resolveLines.mockResolvedValue([
      resolvedLine,
      {
        ...resolvedLine,
        lineNumber: 2,
        productId: PRODUCT_B_ID,
        unitWeight: new Prisma.Decimal('5'),
      },
    ]);

    const view = await service.update(
      ORDER_ID,
      {
        version: 1,
        lines: [
          { productId: PRODUCT_A_ID, quantity: '10' },
          { productId: PRODUCT_B_ID, quantity: '10' },
        ],
      },
      commandContext,
    );

    expect(view.version).toBe(2);
    expect(references.resolveCustomer).not.toHaveBeenCalled();
    expect(references.resolveWarehouse).not.toHaveBeenCalled();
    const updateArgs = tx.salesOrder.updateMany.mock.calls[0]?.[0];
    expect(updateArgs.where).toMatchObject({
      id: ORDER_ID,
      tenantId: TENANT_ID,
      version: 1n,
    });
    expect(updateArgs.data.totalWeight.toString()).toBe('60');
    expect(tx.orderLine.deleteMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT_ID, orderId: ORDER_ID },
    });
    expect(tx.orderLine.createMany.mock.calls[0]?.[0].data).toHaveLength(2);
    expect(tx.orderStatusHistory.create).not.toHaveBeenCalled();
    expect(outbox.write).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        eventType: ORDER_EVENT.UPDATED,
        orderVersion: 2n,
      }),
    );
  });

  it('validates a new address against the existing customer', async () => {
    const { service, prisma, tx, references } = setup();
    prisma.salesOrder.findFirst.mockResolvedValue(salesOrderFixture());
    tx.salesOrder.findFirst
      .mockResolvedValueOnce(salesOrderFixture())
      .mockResolvedValue(salesOrderFixture({ version: 2n }));
    const newAddressId = '22222222-2222-4222-8222-222222222222';

    await service.update(
      ORDER_ID,
      { version: 1, deliveryAddressId: newAddressId },
      commandContext,
    );

    expect(references.resolveCustomer).toHaveBeenCalledWith(
      CUSTOMER_ID,
      newAddressId,
      expect.any(Object),
    );
  });
});

describe('OrderCommandService.cancel', () => {
  it('resets FIFO position and resolves old shortages when pending lines change', async () => {
    const { service, prisma, tx } = setup();
    const pending = salesOrderFixture({
      status: 'PENDING_STOCK',
      pendingSince: new Date('2026-01-01'),
    });
    prisma.salesOrder.findFirst.mockResolvedValue(pending);
    tx.salesOrder.findFirst.mockResolvedValue(pending);
    await service.update(
      ORDER_ID,
      { version: 1, lines: [{ productId: PRODUCT_A_ID, quantity: '10' }] },
      commandContext,
    );
    const data = tx.salesOrder.updateMany.mock.calls[0][0].data;
    expect(data.pendingSince).toBeInstanceOf(Date);
    expect(data.pendingSince.getTime()).toBeGreaterThan(
      pending.pendingSince!.getTime(),
    );
    expect(tx.orderShortage.updateMany).toHaveBeenCalledWith({
      where: {
        tenantId: TENANT_ID,
        orderId: ORDER_ID,
        resolvedAt: null,
        deletedAt: null,
      },
      data: { resolvedAt: expect.any(Date), version: { increment: 1 } },
    });
  });

  it('keeps FIFO position and shortages when a pending edit does not change lines or warehouse', async () => {
    const { service, prisma, tx } = setup();
    const pending = salesOrderFixture({
      status: 'PENDING_STOCK',
      pendingSince: new Date('2026-01-01'),
    });
    prisma.salesOrder.findFirst.mockResolvedValue(pending);
    tx.salesOrder.findFirst.mockResolvedValue(pending);
    await service.update(
      ORDER_ID,
      { version: 1, currency: 'USD' },
      commandContext,
    );
    expect(tx.salesOrder.updateMany.mock.calls[0][0].data).not.toHaveProperty(
      'pendingSince',
    );
    expect(tx.orderShortage.updateMany).not.toHaveBeenCalled();
  });

  it('persists the intent before release and leaves it retryable on upstream failure', async () => {
    const { service, prisma, tx, inventory, outbox } = setup();
    const intent = salesOrderFixture({
      status: 'CONFIRMED',
      version: 3n,
      cancellationRequestedAt: new Date(),
      cancellationReason: 'QA recovery',
      cancellationActorId: commandContext.actorId,
      cancellationCorrelationId: commandContext.correlationId,
    });
    tx.salesOrder.findFirst.mockResolvedValue(
      salesOrderFixture({ status: 'CONFIRMED', version: 2n }),
    );
    prisma.salesOrder.findFirst.mockResolvedValue(intent);
    inventory.release.mockRejectedValue(
      OrderErrors.upstreamUnavailable('inventory-service'),
    );
    await expect(
      service.cancel(
        ORDER_ID,
        { version: 2, reason: 'QA recovery' },
        commandContext,
      ),
    ).rejects.toMatchObject({ httpStatus: 503 });
    expect(tx.salesOrder.update.mock.calls[0][0].data).toMatchObject({
      cancellationReason: 'QA recovery',
      version: { increment: 1 },
    });
    expect(tx.salesOrder.update.mock.calls[0][0].data).not.toHaveProperty(
      'status',
    );
    expect(tx.salesOrder.update.mock.invocationCallOrder[0]).toBeLessThan(
      inventory.release.mock.invocationCallOrder[0],
    );
    expect(outbox.write).not.toHaveBeenCalled();
  });

  it('rejects editing an order with a pending cancellation before reference lookups', async () => {
    const { service, prisma, references } = setup();
    prisma.salesOrder.findFirst.mockResolvedValue(
      salesOrderFixture({ cancellationRequestedAt: new Date() }),
    );
    await expect(
      service.update(ORDER_ID, { version: 1, currency: 'USD' }, commandContext),
    ).rejects.toMatchObject({ reason: ORDER_ERROR_REASON.INVALID_TRANSITION });
    expect(references.resolveCustomer).not.toHaveBeenCalled();
  });

  it('does not edit an orphan reserved order and requires authoritative reconciliation', async () => {
    const { service, prisma, tx, inventory } = setup();
    prisma.salesOrder.findFirst.mockResolvedValue(salesOrderFixture());
    tx.salesOrder.findFirst.mockResolvedValue(salesOrderFixture());
    inventory.active.mockResolvedValue({
      reservationGroupId: 'active-reservation',
    });
    await expect(
      service.update(ORDER_ID, { version: 1, currency: 'USD' }, commandContext),
    ).rejects.toMatchObject({ reason: ORDER_ERROR_REASON.INVALID_TRANSITION });
    expect(tx.salesOrder.updateMany).not.toHaveBeenCalled();
  });

  it('returns a cancellation already completed by a recovery worker without releasing again', async () => {
    const { service, prisma, inventory } = setup();
    prisma.salesOrder.findFirst.mockResolvedValue(
      salesOrderFixture({ status: 'CANCELED' }),
    );
    expect(
      (await service.completeCancellation(TENANT_ID, ORDER_ID)).status,
    ).toBe('CANCELED');
    expect(inventory.release).not.toHaveBeenCalled();
  });

  it('cancels a DRAFT order with history and OrderCanceled outbox', async () => {
    const { service, prisma, tx, outbox } = setup();
    const intent = salesOrderFixture({
      cancellationRequestedAt: new Date(),
      cancellationReason: 'Khách hủy',
      cancellationActorId: commandContext.actorId,
      cancellationCorrelationId: commandContext.correlationId,
      version: 2n,
    });
    prisma.salesOrder.findFirst.mockResolvedValue(intent);
    tx.salesOrder.findFirst
      .mockResolvedValueOnce(salesOrderFixture())
      .mockResolvedValueOnce(intent)
      .mockResolvedValue(
        salesOrderFixture({
          status: 'CANCELED',
          version: 3n,
          cancelReason: 'Khách hủy',
        }),
      );

    const view = await service.cancel(
      ORDER_ID,
      { version: 1, reason: 'Khách hủy' },
      commandContext,
    );

    expect(view.status).toBe('CANCELED');
    expect(tx.salesOrder.update.mock.calls[1]?.[0].data).toMatchObject({
      status: 'CANCELED',
      cancelReason: 'Khách hủy',
    });
    expect(tx.orderStatusHistory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        fromStatus: 'DRAFT',
        toStatus: 'CANCELED',
        orderVersion: 3n,
      }),
    });
    expect(outbox.write).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        eventType: ORDER_EVENT.CANCELED,
        payload: expect.objectContaining({
          previousStatus: 'DRAFT',
          reason: 'Khách hủy',
        }),
      }),
    );
  });

  it('rejects canceling an already canceled order with 409', async () => {
    const { service, tx } = setup();
    tx.salesOrder.findFirst.mockResolvedValue(
      salesOrderFixture({ status: 'CANCELED' }),
    );

    await expect(
      service.cancel(
        ORDER_ID,
        { version: 1, reason: 'Lặp lại' },
        commandContext,
      ),
    ).rejects.toMatchObject({
      reason: ORDER_ERROR_REASON.INVALID_TRANSITION,
      httpStatus: 409,
    });
  });

  it('rejects cancellation after a dispatch grant even before IN_DELIVERY projection', async () => {
    const { service, tx, inventory } = setup();
    tx.salesOrder.findFirst.mockResolvedValue(salesOrderFixture({
      status: 'READY_TO_SHIP', version: 8n, dispatchGrantedAt: new Date(),
    }));
    await expect(service.cancel(
      ORDER_ID, { version: 8, reason: 'Cancel after grant' }, commandContext,
    )).rejects.toMatchObject({
      reason: ORDER_ERROR_REASON.DISPATCH_COMMITTED, httpStatus: 409,
    });
    expect(tx.salesOrder.update).not.toHaveBeenCalled();
    expect(inventory.release).not.toHaveBeenCalled();
  });

  it('never releases stock if cancellation recovery encounters a dispatch grant', async () => {
    const { service, prisma, inventory } = setup();
    prisma.salesOrder.findFirst.mockResolvedValue(salesOrderFixture({
      status: 'READY_TO_SHIP',
      dispatchGrantedAt: new Date(),
      cancellationRequestedAt: new Date(),
      cancellationReason: 'Inconsistent persisted intent',
      cancellationCorrelationId: commandContext.correlationId,
    }));
    await expect(service.completeCancellation(TENANT_ID, ORDER_ID)).rejects.toMatchObject({
      reason: ORDER_ERROR_REASON.DISPATCH_COMMITTED,
    });
    expect(inventory.release).not.toHaveBeenCalled();
  });

  it.each(['PICKING', 'READY_TO_SHIP'])('allows cancellation before a dispatch grant in %s', async (status) => {
    const { service, prisma, tx, inventory } = setup();
    const current = salesOrderFixture({ status });
    const intent = salesOrderFixture({
      status, version: 2n, cancellationRequestedAt: new Date(),
      cancellationReason: 'QA cancel', cancellationActorId: commandContext.actorId,
      cancellationCorrelationId: commandContext.correlationId,
    });
    prisma.salesOrder.findFirst.mockResolvedValue(intent);
    tx.salesOrder.findFirst.mockResolvedValueOnce(current).mockResolvedValueOnce(intent)
      .mockResolvedValue(salesOrderFixture({ status: 'CANCELED', version: 3n }));
    expect((await service.cancel(ORDER_ID, { version: 1, reason: 'QA cancel' }, commandContext)).status)
      .toBe('CANCELED');
    expect(inventory.release).toHaveBeenCalledOnce();
  });

  it.each(['IN_DELIVERY', 'DELIVERY_FAILED', 'COMPLETED'])('does not cancel %s', async (status) => {
    const { service, tx, inventory } = setup();
    tx.salesOrder.findFirst.mockResolvedValue(salesOrderFixture({ status }));
    await expect(service.cancel(
      ORDER_ID, { version: 1, reason: 'QA cancel' }, commandContext,
    )).rejects.toMatchObject({ httpStatus: 409 });
    expect(inventory.release).not.toHaveBeenCalled();
    expect(tx.salesOrder.update).not.toHaveBeenCalled();
  });
});
