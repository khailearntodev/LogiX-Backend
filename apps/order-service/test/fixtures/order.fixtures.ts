import { Prisma } from '../../src/generated/prisma/client.js';
import type {
  MasterDataCustomer,
  MasterDataCustomerAddress,
  MasterDataProduct,
  MasterDataWarehouse,
} from '../../src/orders/integrations/master-data.types.js';
import type { SalesOrderWithLines } from '../../src/orders/mappers/order.mapper.js';
import type { OrderCommandContext } from '../../src/orders/order.types.js';

export const TENANT_ID = '0b9a3c3e-1f5d-4b8e-9a51-1d0a6f3c2b10';
export const ACTOR_ID = '6f1c2d3e-4b5a-4c6d-8e7f-90a1b2c3d4e5';
export const CUSTOMER_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
export const ADDRESS_ID = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e';
export const WAREHOUSE_ID = 'c3d4e5f6-a7b8-4c9d-8e1f-2a3b4c5d6e7f';
export const PRODUCT_A_ID = 'd4e5f6a7-b8c9-4d0e-9f2a-3b4c5d6e7f80';
export const PRODUCT_B_ID = 'e5f6a7b8-c9d0-4e1f-8a3b-4c5d6e7f8091';
export const ORDER_ID = 'f6a7b8c9-d0e1-4f2a-9b4c-5d6e7f8091a2';

export const commandContext: OrderCommandContext = {
  tenantId: TENANT_ID,
  actorId: ACTOR_ID,
  correlationId: '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a',
  authorization: 'Bearer test-token',
};

export const customerFixture = (
  overrides: Partial<MasterDataCustomer> = {},
): MasterDataCustomer => ({
  id: CUSTOMER_ID,
  code: 'CUS-001',
  name: 'Công ty Alpha',
  taxCode: '0101234567',
  phone: '0900000001',
  email: 'alpha@example.com',
  status: 'ACTIVE',
  version: 3,
  ...overrides,
});

export const addressFixture = (
  overrides: Partial<MasterDataCustomerAddress> = {},
): MasterDataCustomerAddress => ({
  id: ADDRESS_ID,
  customerId: CUSTOMER_ID,
  addressType: 'SHIPPING',
  label: 'Kho nhận',
  recipientName: 'Nguyễn Văn A',
  phone: '0900000002',
  addressLine: '1 Lê Lợi',
  ward: 'Bến Nghé',
  district: 'Quận 1',
  province: 'Hồ Chí Minh',
  postalCode: null,
  latitude: null,
  longitude: null,
  deliveryNote: null,
  status: 'ACTIVE',
  version: 2,
  ...overrides,
});

export const warehouseFixture = (
  overrides: Partial<MasterDataWarehouse> = {},
): MasterDataWarehouse => ({
  id: WAREHOUSE_ID,
  code: 'WH-HCM',
  name: 'Kho HCM',
  addressLine: '10 Nguyễn Huệ',
  ward: null,
  district: 'Quận 1',
  province: 'Hồ Chí Minh',
  postalCode: null,
  latitude: '10.776900',
  longitude: '106.700900',
  status: 'ACTIVE',
  version: 1,
  ...overrides,
});

export const productFixture = (
  overrides: Partial<MasterDataProduct> = {},
): MasterDataProduct => ({
  id: PRODUCT_A_ID,
  sku: 'SKU-A',
  name: 'Sản phẩm A',
  baseUnit: 'PCS',
  weight: '1.000',
  volume: '0.010000',
  status: 'ACTIVE',
  version: 1,
  ...overrides,
});

const FIXED_TIME = new Date('2025-03-10T03:00:00.000Z');

export const salesOrderFixture = (
  overrides: Partial<SalesOrderWithLines> = {},
): SalesOrderWithLines => ({
  id: ORDER_ID,
  tenantId: TENANT_ID,
  orderNumber: 'SO-20250310-000001',
  customerId: CUSTOMER_ID,
  deliveryAddressId: ADDRESS_ID,
  warehouseId: WAREHOUSE_ID,
  customerSnapshot: {
    customerId: CUSTOMER_ID,
    code: 'CUS-001',
    name: 'Công ty Alpha',
  },
  deliveryAddressSnapshot: { addressId: ADDRESS_ID, addressType: 'SHIPPING' },
  warehouseSnapshot: {
    warehouseId: WAREHOUSE_ID,
    code: 'WH-HCM',
    name: 'Kho HCM',
  },
  billingAddressSnapshot: null,
  currency: 'VND',
  status: 'DRAFT',
  orderSource: 'MANUAL',
  externalChannel: null,
  externalOrderId: null,
  idempotencyKey: 'create-order-0001',
  idempotencyRequestHash: 'hash',
  totalQuantity: new Prisma.Decimal('10'),
  totalWeight: new Prisma.Decimal('10'),
  totalVolume: new Prisma.Decimal('0.1'),
  pendingSince: null,
  confirmedAt: null,
  reservationGroupId: null,
  cancellationRequestedAt: null,
  cancellationReason: null,
  cancellationActorId: null,
  cancellationCorrelationId: null,
  canceledAt: null,
  completedAt: null,
  cancelReason: null,
  createdAt: FIXED_TIME,
  updatedAt: FIXED_TIME,
  deletedAt: null,
  version: 1n,
  lines: [
    {
      id: '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d',
      tenantId: TENANT_ID,
      orderId: ORDER_ID,
      lineNumber: 1,
      productId: PRODUCT_A_ID,
      skuSnapshot: 'SKU-A',
      productNameSnapshot: 'Sản phẩm A',
      unitSnapshot: 'PCS',
      quantity: new Prisma.Decimal('10'),
      unitWeight: new Prisma.Decimal('1'),
      unitVolume: new Prisma.Decimal('0.01'),
      createdAt: FIXED_TIME,
      updatedAt: FIXED_TIME,
      deletedAt: null,
      version: 1n,
    },
  ],
  ...overrides,
});
