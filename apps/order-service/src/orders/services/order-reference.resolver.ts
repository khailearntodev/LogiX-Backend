import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  AddressSnapshot,
  CustomerSnapshot,
  WarehouseSnapshot,
} from '@logix/messaging';
import { Prisma } from '../../generated/prisma/client.js';
import {
  DELIVERY_ADDRESS_TYPE,
  MASTER_DATA_MAX_CONCURRENT_REQUESTS,
  MASTER_DATA_RECORD_STATUS_ACTIVE,
} from '../domain/order-constants.js';
import { OrderErrors } from '../domain/order-errors.js';
import type { OrderLineInputDto } from '../dto/create-order.dto.js';
import { MasterDataClient } from '../integrations/master-data.client.js';
import type {
  MasterDataProduct,
  MasterDataRequestContext,
} from '../integrations/master-data.types.js';
import {
  buildAddressSnapshot,
  buildCustomerSnapshot,
  buildWarehouseSnapshot,
} from '../mappers/order.mapper.js';

export interface ResolvedCustomer {
  customerSnapshot: CustomerSnapshot;
  deliveryAddressSnapshot: AddressSnapshot;
}

export interface ResolvedOrderLine {
  lineNumber: number;
  productId: string;
  skuSnapshot: string;
  productNameSnapshot: string;
  unitSnapshot: string;
  quantity: Prisma.Decimal;
  unitWeight: Prisma.Decimal;
  unitVolume: Prisma.Decimal;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index] as T, index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

/**
 * Validates the Master Data references of an order and turns them into the
 * immutable snapshots stored on the order. Client-provided snapshots or totals
 * are never accepted; everything is rebuilt from upstream responses here.
 */
@Injectable()
export class OrderReferenceResolver {
  private readonly maxLines: number;

  constructor(
    private readonly masterData: MasterDataClient,
    config: ConfigService,
  ) {
    this.maxLines = config.getOrThrow<number>('ORDER_MAX_LINES');
  }

  /** Local line rules; run before any upstream call so invalid input fails fast. */
  assertLineRules(lines: readonly OrderLineInputDto[]): void {
    if (lines.length > this.maxLines) {
      throw OrderErrors.tooManyLines(this.maxLines, lines.length);
    }
    const seen = new Set<string>();
    lines.forEach((line, index) => {
      const productId = line.productId.toLowerCase();
      if (seen.has(productId)) {
        throw OrderErrors.duplicateProduct(
          line.productId,
          `lines[${index}].productId`,
        );
      }
      seen.add(productId);
    });
  }

  async resolveCustomer(
    customerId: string,
    deliveryAddressId: string,
    ctx: MasterDataRequestContext,
  ): Promise<ResolvedCustomer> {
    const [customer, addresses] = await Promise.all([
      this.masterData.getCustomer(customerId, ctx),
      this.masterData.listCustomerAddresses(customerId, ctx),
    ]);

    if (!customer) {
      throw OrderErrors.masterDataNotFound('customerId', customerId);
    }
    if (customer.status !== MASTER_DATA_RECORD_STATUS_ACTIVE) {
      throw OrderErrors.masterDataInactive('customerId', customerId);
    }

    const address = addresses?.find(
      (candidate) =>
        candidate.id === deliveryAddressId &&
        candidate.customerId === customer.id,
    );
    if (!address) {
      throw OrderErrors.addressNotOfCustomer(deliveryAddressId, customerId);
    }
    if (address.status !== MASTER_DATA_RECORD_STATUS_ACTIVE) {
      throw OrderErrors.masterDataInactive(
        'deliveryAddressId',
        deliveryAddressId,
      );
    }
    if (address.addressType !== DELIVERY_ADDRESS_TYPE) {
      throw OrderErrors.addressNotShipping(deliveryAddressId);
    }

    return {
      customerSnapshot: buildCustomerSnapshot(customer),
      deliveryAddressSnapshot: buildAddressSnapshot(address),
    };
  }

  async resolveWarehouse(
    warehouseId: string,
    ctx: MasterDataRequestContext,
  ): Promise<WarehouseSnapshot> {
    const warehouse = await this.masterData.getWarehouse(warehouseId, ctx);
    if (!warehouse) {
      throw OrderErrors.masterDataNotFound('warehouseId', warehouseId);
    }
    if (warehouse.status !== MASTER_DATA_RECORD_STATUS_ACTIVE) {
      throw OrderErrors.masterDataInactive('warehouseId', warehouseId);
    }
    return buildWarehouseSnapshot(warehouse);
  }

  async resolveLines(
    lines: readonly OrderLineInputDto[],
    ctx: MasterDataRequestContext,
  ): Promise<ResolvedOrderLine[]> {
    const products = await mapWithConcurrency(
      lines,
      MASTER_DATA_MAX_CONCURRENT_REQUESTS,
      (line) => this.masterData.getProduct(line.productId, ctx),
    );

    return lines.map((line, index) => {
      const field = `lines[${index}].productId`;
      const product = products[index];
      if (!product) {
        throw OrderErrors.masterDataNotFound(field, line.productId);
      }
      if (product.status !== MASTER_DATA_RECORD_STATUS_ACTIVE) {
        throw OrderErrors.masterDataInactive(field, line.productId);
      }
      return this.toResolvedLine(index + 1, line, product);
    });
  }

  private toResolvedLine(
    lineNumber: number,
    line: OrderLineInputDto,
    product: MasterDataProduct,
  ): ResolvedOrderLine {
    return {
      lineNumber,
      productId: product.id,
      skuSnapshot: product.sku,
      productNameSnapshot: product.name,
      unitSnapshot: product.baseUnit,
      quantity: new Prisma.Decimal(line.quantity),
      unitWeight: new Prisma.Decimal(product.weight),
      unitVolume: new Prisma.Decimal(product.volume),
    };
  }
}
