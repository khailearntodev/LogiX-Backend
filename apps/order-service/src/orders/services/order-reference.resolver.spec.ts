import type { ConfigService } from '@nestjs/config';
import {
  ADDRESS_ID,
  CUSTOMER_ID,
  PRODUCT_A_ID,
  PRODUCT_B_ID,
  WAREHOUSE_ID,
  addressFixture,
  customerFixture,
  productFixture,
  warehouseFixture,
} from '../../../test/fixtures/order.fixtures.js';
import { ORDER_ERROR_REASON } from '../domain/order-errors.js';
import type { MasterDataClient } from '../integrations/master-data.client.js';
import { OrderReferenceResolver } from './order-reference.resolver.js';

const MAX_LINES = 3;
const ctx = { authorization: 'Bearer token', correlationId: 'corr' };

const createResolver = () => {
  const masterData = {
    getCustomer: vi.fn().mockResolvedValue(customerFixture()),
    listCustomerAddresses: vi.fn().mockResolvedValue([addressFixture()]),
    getWarehouse: vi.fn().mockResolvedValue(warehouseFixture()),
    getProduct: vi.fn().mockResolvedValue(productFixture()),
  };
  const config = {
    getOrThrow: vi.fn().mockReturnValue(MAX_LINES),
  } as unknown as ConfigService;
  const resolver = new OrderReferenceResolver(
    masterData as unknown as MasterDataClient,
    config,
  );
  return { resolver, masterData };
};

const reasonOf = (reason: string) => expect.objectContaining({ reason });

describe('OrderReferenceResolver', () => {
  describe('assertLineRules', () => {
    it('rejects more lines than ORDER_MAX_LINES', () => {
      const { resolver } = createResolver();
      const lines = Array.from({ length: MAX_LINES + 1 }, (_, i) => ({
        productId: `00000000-0000-4000-8000-00000000000${i}`,
        quantity: '1',
      }));

      expect(() => resolver.assertLineRules(lines)).toThrow(
        reasonOf(ORDER_ERROR_REASON.TOO_MANY_LINES),
      );
    });

    it('rejects the same product twice regardless of case', () => {
      const { resolver } = createResolver();

      expect(() =>
        resolver.assertLineRules([
          { productId: PRODUCT_A_ID, quantity: '1' },
          { productId: PRODUCT_A_ID.toUpperCase(), quantity: '2' },
        ]),
      ).toThrow(
        expect.objectContaining({
          reason: ORDER_ERROR_REASON.DUPLICATE_PRODUCT,
          details: expect.objectContaining({ field: 'lines[1].productId' }),
        }),
      );
    });
  });

  describe('resolveCustomer', () => {
    it('builds customer and address snapshots', async () => {
      const { resolver } = createResolver();

      const result = await resolver.resolveCustomer(
        CUSTOMER_ID,
        ADDRESS_ID,
        ctx,
      );

      expect(result.customerSnapshot).toMatchObject({
        customerId: CUSTOMER_ID,
        customerVersion: 3,
      });
      expect(result.deliveryAddressSnapshot).toMatchObject({
        addressId: ADDRESS_ID,
        addressType: 'SHIPPING',
        addressVersion: 2,
      });
    });

    it('fails when the customer does not exist', async () => {
      const { resolver, masterData } = createResolver();
      masterData.getCustomer.mockResolvedValue(null);

      await expect(
        resolver.resolveCustomer(CUSTOMER_ID, ADDRESS_ID, ctx),
      ).rejects.toEqual(reasonOf(ORDER_ERROR_REASON.MASTER_DATA_NOT_FOUND));
    });

    it('fails when the customer is inactive', async () => {
      const { resolver, masterData } = createResolver();
      masterData.getCustomer.mockResolvedValue(
        customerFixture({ status: 'INACTIVE' }),
      );

      await expect(
        resolver.resolveCustomer(CUSTOMER_ID, ADDRESS_ID, ctx),
      ).rejects.toEqual(reasonOf(ORDER_ERROR_REASON.MASTER_DATA_INACTIVE));
    });

    it('fails when the address belongs to another customer', async () => {
      const { resolver, masterData } = createResolver();
      masterData.listCustomerAddresses.mockResolvedValue([
        addressFixture({ customerId: '11111111-1111-4111-8111-111111111111' }),
      ]);

      await expect(
        resolver.resolveCustomer(CUSTOMER_ID, ADDRESS_ID, ctx),
      ).rejects.toEqual(reasonOf(ORDER_ERROR_REASON.ADDRESS_NOT_OF_CUSTOMER));
    });

    it('fails when the address is missing from the customer list', async () => {
      const { resolver, masterData } = createResolver();
      masterData.listCustomerAddresses.mockResolvedValue([]);

      await expect(
        resolver.resolveCustomer(CUSTOMER_ID, ADDRESS_ID, ctx),
      ).rejects.toEqual(reasonOf(ORDER_ERROR_REASON.ADDRESS_NOT_OF_CUSTOMER));
    });

    it('fails when the address is inactive', async () => {
      const { resolver, masterData } = createResolver();
      masterData.listCustomerAddresses.mockResolvedValue([
        addressFixture({ status: 'INACTIVE' }),
      ]);

      await expect(
        resolver.resolveCustomer(CUSTOMER_ID, ADDRESS_ID, ctx),
      ).rejects.toEqual(reasonOf(ORDER_ERROR_REASON.MASTER_DATA_INACTIVE));
    });

    it('fails when the address is not a SHIPPING address', async () => {
      const { resolver, masterData } = createResolver();
      masterData.listCustomerAddresses.mockResolvedValue([
        addressFixture({ addressType: 'BILLING' }),
      ]);

      await expect(
        resolver.resolveCustomer(CUSTOMER_ID, ADDRESS_ID, ctx),
      ).rejects.toEqual(reasonOf(ORDER_ERROR_REASON.ADDRESS_NOT_SHIPPING));
    });
  });

  describe('resolveWarehouse', () => {
    it('rejects inactive warehouses', async () => {
      const { resolver, masterData } = createResolver();
      masterData.getWarehouse.mockResolvedValue(
        warehouseFixture({ status: 'INACTIVE' }),
      );

      await expect(
        resolver.resolveWarehouse(WAREHOUSE_ID, ctx),
      ).rejects.toEqual(reasonOf(ORDER_ERROR_REASON.MASTER_DATA_INACTIVE));
    });
  });

  describe('resolveLines', () => {
    it('snapshots product data in request order with 1-based line numbers', async () => {
      const { resolver, masterData } = createResolver();
      masterData.getProduct.mockImplementation(async (id: string) =>
        id === PRODUCT_B_ID
          ? productFixture({ id: PRODUCT_B_ID, sku: 'SKU-B', weight: '5.000' })
          : productFixture(),
      );

      const lines = await resolver.resolveLines(
        [
          { productId: PRODUCT_B_ID, quantity: '5' },
          { productId: PRODUCT_A_ID, quantity: '10.5' },
        ],
        ctx,
      );

      expect(lines.map((l) => [l.lineNumber, l.skuSnapshot])).toEqual([
        [1, 'SKU-B'],
        [2, 'SKU-A'],
      ]);
      expect(lines[0]?.unitWeight.toString()).toBe('5');
      expect(lines[1]?.quantity.toString()).toBe('10.5');
      expect(lines[1]?.unitSnapshot).toBe('PCS');
    });

    it('reports the failing line index for missing products', async () => {
      const { resolver, masterData } = createResolver();
      masterData.getProduct.mockImplementation(async (id: string) =>
        id === PRODUCT_B_ID ? null : productFixture(),
      );

      await expect(
        resolver.resolveLines(
          [
            { productId: PRODUCT_A_ID, quantity: '1' },
            { productId: PRODUCT_B_ID, quantity: '1' },
          ],
          ctx,
        ),
      ).rejects.toEqual(
        expect.objectContaining({
          reason: ORDER_ERROR_REASON.MASTER_DATA_NOT_FOUND,
          details: expect.objectContaining({ field: 'lines[1].productId' }),
        }),
      );
    });

    it('never exceeds the concurrent request limit', async () => {
      const { resolver, masterData } = createResolver();
      let inFlight = 0;
      let peak = 0;
      masterData.getProduct.mockImplementation(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        return productFixture();
      });
      const lines = Array.from({ length: 25 }, () => ({
        productId: PRODUCT_A_ID,
        quantity: '1',
      }));

      await resolver.resolveLines(lines, ctx);

      expect(masterData.getProduct).toHaveBeenCalledTimes(25);
      expect(peak).toBeLessThanOrEqual(10);
    });
  });
});
