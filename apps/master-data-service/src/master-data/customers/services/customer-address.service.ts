import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service.js';
import { Prisma } from '../../../generated/prisma/client.js';
import { RecordStatus } from '../../common/master-data.constants.js';
import { toCustomerAddressView } from '../../common/master-data.mappers.js';
import type { CustomerAddressView } from '../../common/master-data.types.js';
import type {
  CreateCustomerAddressDto,
  UpdateCustomerAddressDto,
} from '../dto/customer-address.dto.js';

@Injectable()
export class CustomerAddressService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    tenantId: string,
    customerId: string,
  ): Promise<CustomerAddressView[]> {
    await this.requireCustomer(tenantId, customerId);

    const rows = await this.prisma.customerAddress.findMany({
      where: { tenantId, customerId, deletedAt: null },
      orderBy: [{ isDefault: 'desc' }, { recipientName: 'asc' }],
    });

    return rows.map(toCustomerAddressView);
  }

  async create(
    tenantId: string,
    customerId: string,
    dto: CreateCustomerAddressDto,
  ): Promise<CustomerAddressView> {
    await this.requireCustomer(tenantId, customerId);

    const makeDefault = dto.isDefault === true;

    const row = await this.prisma.$transaction(async (tx) => {
      if (makeDefault) {
        await this.clearDefault(tx, tenantId, customerId);
      }

      return tx.customerAddress.create({
        data: {
          tenantId,
          customerId,
          label: dto.label ?? null,
          recipientName: dto.recipientName,
          phone: dto.phone ?? null,
          addressLine: dto.addressLine,
          ward: dto.ward ?? null,
          district: dto.district ?? null,
          province: dto.province,
          postalCode: dto.postalCode ?? null,
          latitude: dto.latitude ? new Prisma.Decimal(dto.latitude) : null,
          longitude: dto.longitude ? new Prisma.Decimal(dto.longitude) : null,
          isDefault: makeDefault,
          status: RecordStatus.ACTIVE,
        },
      });
    });

    return toCustomerAddressView(row);
  }

  async update(
    tenantId: string,
    customerId: string,
    addressId: string,
    dto: UpdateCustomerAddressDto,
  ): Promise<CustomerAddressView> {
    await this.requireAddress(tenantId, customerId, addressId);

    const row = await this.prisma.customerAddress.update({
      where: { id: addressId },
      data: {
        ...(dto.label === undefined ? {} : { label: dto.label }),
        ...(dto.recipientName === undefined
          ? {}
          : { recipientName: dto.recipientName }),
        ...(dto.phone === undefined ? {} : { phone: dto.phone }),
        ...(dto.addressLine === undefined
          ? {}
          : { addressLine: dto.addressLine }),
        ...(dto.ward === undefined ? {} : { ward: dto.ward }),
        ...(dto.district === undefined ? {} : { district: dto.district }),
        ...(dto.province === undefined ? {} : { province: dto.province }),
        ...(dto.postalCode === undefined ? {} : { postalCode: dto.postalCode }),
        ...(dto.latitude === undefined
          ? {}
          : { latitude: new Prisma.Decimal(dto.latitude) }),
        ...(dto.longitude === undefined
          ? {}
          : { longitude: new Prisma.Decimal(dto.longitude) }),
        version: { increment: 1 },
      },
    });

    return toCustomerAddressView(row);
  }

  /**
   * Clear-then-set in one transaction so `ux_customer_default_address`
   * (partial unique on tenant + customer where is_default and ACTIVE) cannot be
   * violated by two concurrent promotions.
   */
  async setDefault(
    tenantId: string,
    customerId: string,
    addressId: string,
  ): Promise<CustomerAddressView> {
    const current = await this.requireAddress(tenantId, customerId, addressId);

    if (current.status !== RecordStatus.ACTIVE) {
      throw new NotFoundException(
        'Không thể đặt địa chỉ đã ngừng hoạt động làm mặc định',
      );
    }

    const row = await this.prisma.$transaction(async (tx) => {
      await this.clearDefault(tx, tenantId, customerId);

      return tx.customerAddress.update({
        where: { id: addressId },
        data: { isDefault: true, version: { increment: 1 } },
      });
    });

    return toCustomerAddressView(row);
  }

  /** Disabling the default address also drops the default flag. */
  async setStatus(
    tenantId: string,
    customerId: string,
    addressId: string,
    status: RecordStatus,
  ): Promise<CustomerAddressView> {
    const current = await this.requireAddress(tenantId, customerId, addressId);

    if (current.status === status) {
      return toCustomerAddressView(current);
    }

    const row = await this.prisma.customerAddress.update({
      where: { id: addressId },
      data: {
        status,
        ...(status === RecordStatus.INACTIVE ? { isDefault: false } : {}),
        version: { increment: 1 },
      },
    });

    return toCustomerAddressView(row);
  }

  private async clearDefault(
    tx: Prisma.TransactionClient,
    tenantId: string,
    customerId: string,
  ): Promise<void> {
    await tx.customerAddress.updateMany({
      where: { tenantId, customerId, isDefault: true, deletedAt: null },
      data: { isDefault: false },
    });
  }

  private async requireCustomer(tenantId: string, customerId: string) {
    const customer = await this.prisma.customer.findFirst({
      where: { id: customerId, tenantId, deletedAt: null },
    });

    if (!customer) {
      throw new NotFoundException('Không tìm thấy khách hàng');
    }

    return customer;
  }

  private async requireAddress(
    tenantId: string,
    customerId: string,
    addressId: string,
  ) {
    const row = await this.prisma.customerAddress.findFirst({
      where: { id: addressId, customerId, tenantId, deletedAt: null },
    });

    if (!row) {
      throw new NotFoundException('Không tìm thấy địa chỉ giao hàng');
    }

    return row;
  }
}
