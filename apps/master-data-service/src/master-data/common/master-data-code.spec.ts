import 'reflect-metadata';
import { plainToInstance, type ClassConstructor } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CreateCustomerDto,
  UpdateCustomerDto,
} from '../customers/dto/customer.dto.js';
import {
  CreateProductDto,
  UpdateProductDto,
} from '../products/dto/product.dto.js';
import { CreateWarehouseDto } from '../warehouses/dto/create-warehouse.dto.js';
import { UpdateWarehouseDto } from '../warehouses/dto/update-warehouse.dto.js';
import {
  CreateVehicleDto,
  UpdateVehicleDto,
} from '../vehicles/dto/vehicle.dto.js';
import { CreateDriverDto, UpdateDriverDto } from '../drivers/dto/driver.dto.js';
import {
  highestMasterDataCodeSequence,
  nextMasterDataCode,
} from './master-data-code.js';

describe('master-data code generation', () => {
  const createCases: {
    type: ClassConstructor<object>;
    data: Record<string, unknown>;
    field: string;
  }[] = [
    { type: CreateCustomerDto, data: { name: 'Customer' }, field: 'code' },
    {
      type: CreateWarehouseDto,
      data: {
        name: 'Warehouse',
        addressLine: 'Address',
        province: 'Province',
      },
      field: 'code',
    },
    {
      type: CreateProductDto,
      data: { name: 'Product', baseUnit: 'each', weight: '1', volume: '1' },
      field: 'sku',
    },
    {
      type: CreateVehicleDto,
      data: {
        licensePlate: 'ABC-123',
        capacityWeight: '1',
        capacityVolume: '1',
      },
      field: 'code',
    },
    {
      type: CreateDriverDto,
      data: {
        userId: '74cc6e08-e865-49a2-b3e7-e2ee00fc894b',
        licenseNumber: 'LICENSE',
        licenseExpiry: '2027-10-25',
      },
      field: 'code',
    },
  ];

  const updateCases: {
    type: ClassConstructor<object>;
    field: string;
    data: Record<string, unknown>;
  }[] = [
    { type: UpdateCustomerDto, field: 'code', data: {} },
    { type: UpdateWarehouseDto, field: 'code', data: {} },
    { type: UpdateProductDto, field: 'sku', data: {} },
    { type: UpdateVehicleDto, field: 'code', data: {} },
    { type: UpdateDriverDto, field: 'code', data: { version: 1 } },
  ];

  it.each([
    ['customer', 'CUS-000001'],
    ['warehouse', 'WH-000001'],
    ['product', 'PRD-000001'],
    ['vehicle', 'VEH-000001'],
    ['driver', 'DRV-000001'],
  ] as const)('uses the approved %s prefix', (type, expected) => {
    expect(nextMasterDataCode(type, 1n)).toBe(expected);
  });

  it('continues after the highest existing numeric code without reusing gaps', () => {
    expect(
      highestMasterDataCodeSequence('driver', [
        'DRV-000001',
        'DRV-000009',
        'DRV-000007',
        'OTHER-100000',
        'DRV-legacy',
        'drv-000020',
      ]),
    ).toBe(9n);
    expect(nextMasterDataCode('driver', 10n)).toBe('DRV-000010');
  });

  it('continues beyond six digits', () => {
    expect(
      nextMasterDataCode(
        'product',
        highestMasterDataCodeSequence('product', ['PRD-999999']) + 1n,
      ),
    ).toBe('PRD-1000000');
  });

  it('retains the persisted high-water mark after a generated code is edited', () => {
    const storedHighWaterMark = highestMasterDataCodeSequence('driver', [
      'DRV-000001',
      'DRV-000002',
    ]);
    const currentCodesAfterEdit = ['DRV-000001', 'driver-code-renamed'];
    const nextSequence =
      (highestMasterDataCodeSequence('driver', currentCodesAfterEdit) >
      storedHighWaterMark
        ? highestMasterDataCodeSequence('driver', currentCodesAfterEdit)
        : storedHighWaterMark) + 1n;

    expect(nextMasterDataCode('driver', nextSequence)).toBe('DRV-000003');
  });

  it('allows omitted, blank, and arbitrary nonblank create codes for every resource', async () => {
    for (const { type, data, field } of createCases) {
      for (const code of [undefined, '   ', 'Custom / code']) {
        const body: Record<string, unknown> = { ...data };
        if (code !== undefined) body[field] = code;
        const dto = plainToInstance(type, body);
        expect(await validate(dto)).toEqual([]);
        if (code !== undefined) {
          expect((dto as unknown as Record<string, unknown>)[field]).toBe(
            code.trim(),
          );
        }
      }
    }
  });

  it('allows optional code changes on update and treats blank values as optional', async () => {
    for (const { type, field, data } of updateCases) {
      for (const code of ['   ', 'Custom / code']) {
        const dto = plainToInstance(type, { ...data, [field]: code });
        expect(await validate(dto)).toEqual([]);
        expect((dto as unknown as Record<string, unknown>)[field]).toBe(
          code.trim(),
        );
      }
    }
  });
});
