import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { validate } from 'class-validator';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { INTERNAL_CALLERS_KEY, InternalServiceGuard } from '@logix/auth';
import { AuthorizeDispatchDto } from './dto/authorize-dispatch.dto.js';
import { OrdersDispatchInternalController } from './orders-dispatch.internal.controller.js';
import { OrderDispatchService } from './services/order-dispatch.service.js';
import { OrderDispatchBatchService } from './services/order-dispatch-batch.service.js';

const validRequest = () =>
  Object.assign(new AuthorizeDispatchDto(), {
    requestId: randomUUID(),
    shipmentId: randomUUID(),
    reservationGroupId: randomUUID(),
    orderVersion: 1,
    actorId: randomUUID(),
  });

describe('OrdersDispatchInternalController', () => {
  it('only allows Fulfillment using the internal guard, never a user JWT', () => {
    expect(
      Reflect.getMetadata(
        INTERNAL_CALLERS_KEY,
        OrdersDispatchInternalController,
      ),
    ).toEqual(['fulfillment-service']);
    expect(
      Reflect.getMetadata(GUARDS_METADATA, OrdersDispatchInternalController),
    ).toEqual([InternalServiceGuard]);
  });

  it('takes tenant from the authenticated service claim and preserves correlation', async () => {
    const dispatch = { authorize: vi.fn().mockResolvedValue({}) };
    const controller = new OrdersDispatchInternalController(
      dispatch as unknown as OrderDispatchService,
      {} as OrderDispatchBatchService,
    );
    const tenantId = randomUUID();
    const orderId = randomUUID();
    const correlationId = randomUUID();
    const dto = validRequest();
    await controller.authorize(
      orderId,
      dto,
      {
        tenantId,
        service: 'fulfillment-service',
        audience: 'order-service',
      },
      correlationId,
    );
    expect(dispatch.authorize).toHaveBeenCalledWith(
      tenantId,
      orderId,
      dto,
      correlationId,
    );
  });

  it('rejects an invalid correlation UUID before persistence', () => {
    const dispatch = { authorize: vi.fn() };
    const controller = new OrdersDispatchInternalController(
      dispatch as unknown as OrderDispatchService,
      {} as OrderDispatchBatchService,
    );
    expect(() =>
      controller.authorize(
        randomUUID(),
        validRequest(),
        {
          tenantId: randomUUID(),
          service: 'fulfillment-service',
          audience: 'order-service',
        },
        'invalid',
      ),
    ).toThrow('Mã truy vết phải là UUID hợp lệ');
    expect(dispatch.authorize).not.toHaveBeenCalled();
  });

  it('rejects malformed tenant claims before database access', () => {
    const dispatch = { authorize: vi.fn() };
    const controller = new OrdersDispatchInternalController(
      dispatch as unknown as OrderDispatchService,
      {} as OrderDispatchBatchService,
    );
    expect(() =>
      controller.authorize(
        randomUUID(),
        validRequest(),
        {
          tenantId: 'invalid',
          service: 'fulfillment-service',
          audience: 'order-service',
        },
        randomUUID(),
      ),
    ).toThrow('Tổ chức trong token nội bộ không hợp lệ');
    expect(dispatch.authorize).not.toHaveBeenCalled();
  });

  it('accepts a valid DTO', async () => {
    expect(await validate(validRequest())).toHaveLength(0);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1'])(
    'rejects invalid order version %s',
    async (orderVersion) => {
      expect(
        await validate(Object.assign(validRequest(), { orderVersion })),
      ).not.toHaveLength(0);
    },
  );

  it.each(['requestId', 'shipmentId', 'reservationGroupId', 'actorId'])(
    'rejects invalid %s',
    async (field) => {
      expect(
        await validate(Object.assign(validRequest(), { [field]: 'invalid' })),
      ).not.toHaveLength(0);
    },
  );
});
