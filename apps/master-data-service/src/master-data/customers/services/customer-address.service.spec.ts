import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { CustomerAddressService } from './customer-address.service.js';
import { PrismaService } from '../../../database/prisma.service.js';
import { Prisma } from '../../../generated/prisma/client.js';
import { RecordStatus } from '../../common/master-data.constants.js';
import { toConflict } from '../../common/prisma-error.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const CUSTOMER = '22222222-2222-4222-8222-222222222222';
const ADDRESS = '33333333-3333-4333-8333-333333333333';

function addressRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ADDRESS,
    tenantId: TENANT,
    customerId: CUSTOMER,
    label: null,
    recipientName: 'Nguyễn Văn A',
    phone: null,
    addressLine: '12 Nguyễn Trãi',
    ward: null,
    district: null,
    province: 'Hà Nội',
    postalCode: null,
    latitude: new Prisma.Decimal('21.012345'),
    longitude: null,
    isDefault: false,
    status: RecordStatus.ACTIVE,
    version: 1n,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

describe('CustomerAddressService', () => {
  let service: CustomerAddressService;
  let prisma: {
    customer: { findFirst: ReturnType<typeof vi.fn> };
    customerAddress: {
      findFirst: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
    };
    $transaction: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    prisma = {
      customer: { findFirst: vi.fn().mockResolvedValue({ id: CUSTOMER }) },
      customerAddress: {
        findFirst: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        create: vi.fn(),
      },
      // Hand the callback a client that records the same calls.
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn(prisma),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CustomerAddressService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get(CustomerAddressService);
  });

  it('clears the previous default before promoting another address', async () => {
    prisma.customerAddress.findFirst.mockResolvedValue(addressRow());
    prisma.customerAddress.update.mockResolvedValue(
      addressRow({ isDefault: true }),
    );

    const result = await service.setDefault(TENANT, CUSTOMER, ADDRESS);

    expect(prisma.customerAddress.updateMany).toHaveBeenCalledWith({
      where: {
        tenantId: TENANT,
        customerId: CUSTOMER,
        isDefault: true,
        deletedAt: null,
      },
      data: { isDefault: false },
    });
    // Clearing must happen inside the same transaction as the promotion.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(result.isDefault).toBe(true);
  });

  it('refuses to make a disabled address the default', async () => {
    prisma.customerAddress.findFirst.mockResolvedValue(
      addressRow({ status: RecordStatus.INACTIVE }),
    );

    await expect(
      service.setDefault(TENANT, CUSTOMER, ADDRESS),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.customerAddress.update).not.toHaveBeenCalled();
  });

  it('drops the default flag when the default address is disabled', async () => {
    prisma.customerAddress.findFirst.mockResolvedValue(
      addressRow({ isDefault: true }),
    );
    prisma.customerAddress.update.mockResolvedValue(
      addressRow({ isDefault: false, status: RecordStatus.INACTIVE }),
    );

    await service.setStatus(
      TENANT,
      CUSTOMER,
      ADDRESS,
      RecordStatus.INACTIVE,
    );

    expect(prisma.customerAddress.update).toHaveBeenCalledWith({
      where: { id: ADDRESS },
      data: {
        status: RecordStatus.INACTIVE,
        isDefault: false,
        version: { increment: 1 },
      },
    });
  });

  it('scopes every address lookup to the tenant and the customer', async () => {
    prisma.customerAddress.findFirst.mockResolvedValue(null);

    await expect(
      service.update(TENANT, CUSTOMER, ADDRESS, { recipientName: 'B' }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(prisma.customerAddress.findFirst).toHaveBeenCalledWith({
      where: {
        id: ADDRESS,
        customerId: CUSTOMER,
        tenantId: TENANT,
        deletedAt: null,
      },
    });
  });

  it('keeps six decimal digits on coordinates', async () => {
    prisma.customerAddress.create.mockResolvedValue(addressRow());

    const result = await service.create(TENANT, CUSTOMER, {
      recipientName: 'Nguyễn Văn A',
      addressLine: '12 Nguyễn Trãi',
      province: 'Hà Nội',
      latitude: '21.012345',
    });

    expect(result.latitude).toBe('21.012345');
    expect(result.longitude).toBeNull();
  });
});

describe('toConflict', () => {
  it('turns a Prisma unique violation into a 409 with the given message', () => {
    expect(() => toConflict({ code: 'P2002' }, 'Mã kho đã tồn tại')).toThrow(
      ConflictException,
    );
  });

  it('rethrows anything that is not a unique violation', () => {
    const other = new Error('connection lost');
    expect(() => toConflict(other, 'Mã kho đã tồn tại')).toThrow(other);
  });
});
