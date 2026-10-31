import { BadRequestException, Injectable } from '@nestjs/common';
import {
  SHIPMENT_STATUS as S,
  shipmentPoolQuerySchema,
  transportUuidSchema,
} from '@logix/messaging';
import { PrismaService } from '../database/prisma.service.js';
import { INTENT_STATUS, DEFAULT_PAGE_SIZE } from './shipment.domain.js';

@Injectable()
export class ShipmentPoolService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    tenantId: string,
    rawQuery: Record<string, unknown>,
    rawExcludedShipmentIds: unknown,
  ) {
    const acceptedKeys = new Set([
      'contractVersion',
      'warehouseId',
      'page',
      'pageSize',
      'status',
      'excludedShipmentIds',
    ]);
    const repeatedScalar = [
      'contractVersion',
      'warehouseId',
      'page',
      'pageSize',
      'status',
    ].some((key) => Array.isArray(rawQuery[key]));
    if (
      repeatedScalar ||
      Object.keys(rawQuery).some((key) => !acceptedKeys.has(key))
    )
      throw new BadRequestException('Invalid shipment pool query');
    const single = (value: unknown) =>
      Array.isArray(value) ? undefined : value;
    const contractVersion = Number(single(rawQuery.contractVersion));
    const warehouseId = single(rawQuery.warehouseId);
    const page = Number(single(rawQuery.page) ?? 1);
    const pageSize = Number(single(rawQuery.pageSize) ?? DEFAULT_PAGE_SIZE);
    const status = single(rawQuery.status);
    const parsed = shipmentPoolQuerySchema.safeParse({
      contractVersion,
      warehouseId,
      page,
      pageSize,
      ...(status === undefined ? {} : { status }),
    });
    const excludedValues =
      rawExcludedShipmentIds === undefined
        ? []
        : Array.isArray(rawExcludedShipmentIds)
          ? rawExcludedShipmentIds
          : [rawExcludedShipmentIds];
    const excluded = excludedValues.map((value) =>
      typeof value === 'string' ? value : '',
    );
    const validExcluded = excluded.every(
      (value) => transportUuidSchema.safeParse(value).success,
    );
    if (!parsed.success || !validExcluded)
      throw new BadRequestException(
        parsed.success ? 'Invalid excludedShipmentIds' : parsed.error.issues,
      );
    const query = parsed.data;
    const where = {
      tenantId,
      warehouseId: query.warehouseId,
      status: S.READY_TO_SHIP,
      deletedAt: null,
      assignedTripId: null,
      ...(excluded.length > 0 && { id: { notIn: [...new Set(excluded)] } }),
      dispatchIntent: { isNot: { status: INTENT_STATUS.PENDING } },
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.shipment.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.shipment.count({ where }),
    ]);
    return {
      items: rows.map((row) => ({
        shipmentId: row.id,
        shipmentNumber: row.shipmentNumber,
        orderId: row.orderId,
        warehouseId: row.warehouseId,
        shipmentVersion: this.safeVersion(row.version),
        orderVersion: this.safeVersion(row.confirmedOrderVersion),
        status: S.READY_TO_SHIP,
        totalWeight: row.totalWeight.toString(),
        totalVolume: row.totalVolume.toString(),
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  private safeVersion(value: bigint): number {
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result < 1)
      throw new Error('Shipment version exceeds safe integer range');
    return result;
  }
}
