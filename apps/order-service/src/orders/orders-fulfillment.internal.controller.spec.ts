import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { INTERNAL_CALLERS_KEY, InternalServiceGuard } from '@logix/auth';
import { OrdersFulfillmentInternalController } from './orders-fulfillment.internal.controller.js';
import { OrderQueryService } from './services/order-query.service.js';

describe('Fulfillment snapshot internal boundary', () => {
  it('allows only Fulfillment service tokens', () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, OrdersFulfillmentInternalController),
    ).toEqual([InternalServiceGuard]);
    expect(
      Reflect.getMetadata(
        INTERNAL_CALLERS_KEY,
        OrdersFulfillmentInternalController,
      ),
    ).toEqual(['fulfillment-service']);
  });
  it('uses verified tenant context, not client query/body', () => {
    const queries = { detail: vi.fn() };
    const tenantId = randomUUID(),
      orderId = randomUUID();
    new OrdersFulfillmentInternalController(
      queries as unknown as OrderQueryService,
    ).snapshot(orderId, {
      tenantId,
      service: 'fulfillment-service',
      audience: 'order-service',
    });
    expect(queries.detail).toHaveBeenCalledWith(tenantId, orderId);
  });
  it('rejects malformed tenant before persistence', () => {
    const queries = { detail: vi.fn() };
    expect(() =>
      new OrdersFulfillmentInternalController(
        queries as unknown as OrderQueryService,
      ).snapshot(randomUUID(), {
        tenantId: 'bad',
        service: 'fulfillment-service',
        audience: 'order-service',
      }),
    ).toThrow();
    expect(queries.detail).not.toHaveBeenCalled();
  });
});
