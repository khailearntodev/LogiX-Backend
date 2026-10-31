import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { CustomerService } from '../src/master-data/customers/services/customer.service.js';
import { ProductService } from '../src/master-data/products/services/product.service.js';
import { WarehouseService } from '../src/master-data/warehouses/services/warehouse.service.js';
import { VehicleService } from '../src/master-data/vehicles/services/vehicle.service.js';
import { DriverService } from '../src/master-data/drivers/driver.service.js';
import type { IdentityDriverClient } from '../src/master-data/drivers/identity-driver.client.js';
import {
  allocateNextMasterDataCode,
  syncMasterDataCodeSequence,
} from '../src/master-data/common/master-data-code.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error(
    'DATABASE_URL is required for code-sequence integration tests',
  );
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
});

describe('master-data code sequence transactions', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('returns generated codes through each master-data service create path', async () => {
    const tenants = Array.from({ length: 5 }, () => randomUUID());
    const [
      customerTenant,
      warehouseTenant,
      productTenant,
      vehicleTenant,
      driverTenant,
    ] = tenants;
    const customer = new CustomerService(prisma as unknown as PrismaService);
    const warehouse = new WarehouseService(prisma as unknown as PrismaService);
    const product = new ProductService(prisma as unknown as PrismaService);
    const vehicle = new VehicleService(prisma as unknown as PrismaService);
    const driverUserId = randomUUID();
    const driverIdentity = {
      eligible: async (_tenantId: string, id: string) => ({
        id,
        displayName: 'Test Driver',
        email: `${id}@example.test`,
        status: 'ACTIVE',
      }),
    } as unknown as IdentityDriverClient;
    const driver = new DriverService(
      prisma as unknown as PrismaService,
      driverIdentity,
    );

    try {
      const customerRecord = await customer.create(customerTenant, {
        name: 'Generated customer',
      });
      expect(customerRecord.code).toBe('CUS-000001');
      await customer.update(customerTenant, customerRecord.id, {
        code: 'renamed-customer',
      });
      expect(
        (await customer.create(customerTenant, { name: 'Next customer' })).code,
      ).toBe('CUS-000002');

      expect(
        (
          await warehouse.create(warehouseTenant, {
            name: 'Generated warehouse',
            addressLine: 'Address',
            province: 'Province',
          })
        ).code,
      ).toBe('WH-000001');
      expect(
        (
          await product.create(productTenant, {
            name: 'Generated product',
            baseUnit: 'each',
            weight: '1',
            volume: '1',
          })
        ).sku,
      ).toBe('PRD-000001');
      expect(
        (
          await vehicle.create(vehicleTenant, {
            licensePlate: 'TEST-001',
            capacityWeight: '1',
            capacityVolume: '1',
          })
        ).code,
      ).toBe('VEH-000001');
      expect(
        (
          await driver.create(driverTenant, {
            userId: driverUserId,
            licenseNumber: 'TEST-LICENSE',
            licenseExpiry: '2030-01-01',
          })
        ).code,
      ).toBe('DRV-000001');
    } finally {
      await Promise.all([
        prisma.customer.deleteMany({ where: { tenantId: customerTenant } }),
        prisma.warehouse.deleteMany({ where: { tenantId: warehouseTenant } }),
        prisma.product.deleteMany({ where: { tenantId: productTenant } }),
        prisma.vehicle.deleteMany({ where: { tenantId: vehicleTenant } }),
        prisma.driver.deleteMany({ where: { tenantId: driverTenant } }),
        prisma.masterDataCodeSequence.deleteMany({
          where: { tenantId: { in: tenants } },
        }),
      ]);
    }
  });

  it('keeps the high-water mark after the highest existing code is edited', async () => {
    const tenantId = randomUUID();
    try {
      const first = await prisma.$transaction(async (tx) => {
        await syncMasterDataCodeSequence(tx, tenantId, 'driver', [
          'DRV-000001',
        ]);
        return allocateNextMasterDataCode(tx, tenantId, 'driver');
      });

      const afterEdit = await prisma.$transaction(async (tx) => {
        await syncMasterDataCodeSequence(tx, tenantId, 'driver', [
          'DRV-000001',
          'renamed-driver-code',
        ]);
        return allocateNextMasterDataCode(tx, tenantId, 'driver');
      });

      expect(first).toBe('DRV-000002');
      expect(afterEdit).toBe('DRV-000003');
    } finally {
      await prisma.masterDataCodeSequence.deleteMany({ where: { tenantId } });
    }
  });

  it('allocates distinct increasing codes across concurrent transactions', async () => {
    const tenantId = randomUUID();
    try {
      const codes = await Promise.all(
        Array.from({ length: 8 }, () =>
          prisma.$transaction(async (tx) => {
            await syncMasterDataCodeSequence(tx, tenantId, 'customer', []);
            return allocateNextMasterDataCode(tx, tenantId, 'customer');
          }),
        ),
      );

      expect(new Set(codes).size).toBe(8);
      expect(codes.sort()).toEqual([
        'CUS-000001',
        'CUS-000002',
        'CUS-000003',
        'CUS-000004',
        'CUS-000005',
        'CUS-000006',
        'CUS-000007',
        'CUS-000008',
      ]);
    } finally {
      await prisma.masterDataCodeSequence.deleteMany({ where: { tenantId } });
    }
  });
});
