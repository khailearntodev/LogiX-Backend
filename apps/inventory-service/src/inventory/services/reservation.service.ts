import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import {
  Prisma,
  type InventoryBalance,
  type ReservationGroup,
} from '../../generated/prisma/client.js';
import type { ReserveDto } from '../dto/reserve.dto.js';
import type { ReservationPreview, ReserveResult } from '@logix/messaging';
export type { ReserveResult } from '@logix/messaging';

export const RESERVATION_STATUS = {
  ACTIVE: 'ACTIVE',
  RELEASED: 'RELEASED',
  ISSUED: 'ISSUED',
} as const;

export const RESERVATION_EVENT = {
  RESERVED: 'StockReserved',
  RELEASED: 'StockReleased',
} as const;

export interface ReservationContext {
  tenantId: string;
  correlationId: string;
  eventId?: string;
}

export interface ReservationShortage {
  productId: string;
  required: string;
  available: string;
}

const toReserved = (group: ReservationGroup): ReserveResult => ({
  outcome: 'RESERVED',
  reservationGroupId: group.id,
});

@Injectable()
export class ReservationService {
  constructor(private readonly prisma: PrismaService) {}

  async active(orderId: string, tenantId: string) {
    const group = await this.prisma.reservationGroup.findFirst({
      where: {
        tenantId,
        orderId,
        status: RESERVATION_STATUS.ACTIVE,
        deletedAt: null,
      },
    });
    return { reservationGroupId: group?.id ?? null };
  }

  async preview(
    dto: ReserveDto,
    ctx: ReservationContext,
  ): Promise<ReservationPreview> {
    this.assertLines(dto);
    const balances = await this.prisma.inventoryBalance.findMany({
      where: {
        tenantId: ctx.tenantId,
        warehouseId: dto.warehouseId,
        productId: { in: dto.lines.map((line) => line.productId) },
        deletedAt: null,
      },
    });
    return {
      checkedAt: new Date().toISOString(),
      lines: dto.lines.map((line) => {
        const balance = balances.find(
          (item) => item.productId === line.productId,
        );
        const available = balance
          ? balance.onHandQuantity.minus(balance.reservedQuantity)
          : new Prisma.Decimal(0);
        return {
          productId: line.productId,
          required: new Prisma.Decimal(line.quantity).toFixed(3),
          available: available.toFixed(3),
          sufficient: available.greaterThanOrEqualTo(line.quantity),
        };
      }),
    };
  }

  async reserve(
    dto: ReserveDto,
    idempotencyKey: string | undefined,
    ctx: ReservationContext,
  ): Promise<ReserveResult> {
    if (
      !Number.isSafeInteger(dto.orderVersion) ||
      idempotencyKey !== `order:${dto.orderId}:v${dto.orderVersion}`
    ) {
      throw new BadRequestException(
        'Idempotency-Key không khớp đơn hàng và phiên bản',
      );
    }
    this.assertLines(dto);
    return this.prisma.$transaction(async (tx) => {
      await this.lockOrder(tx, ctx.tenantId, dto.orderId);
      const previous = await tx.reservationGroup.findFirst({
        where: { tenantId: ctx.tenantId, idempotencyKey },
        include: { reservations: true },
      });
      if (previous) {
        if (
          previous.status !== RESERVATION_STATUS.ACTIVE ||
          previous.orderId !== dto.orderId ||
          previous.warehouseId !== dto.warehouseId ||
          previous.reservations.length !== dto.lines.length ||
          dto.lines.some(
            (line) =>
              !previous.reservations.some(
                (saved) =>
                  saved.orderLineId === line.orderLineId &&
                  saved.productId === line.productId &&
                  saved.quantity.equals(line.quantity),
              ),
          )
        ) {
          throw new ConflictException(
            'Reservation đã kết thúc hoặc key được dùng với nội dung khác',
          );
        }
        return toReserved(previous);
      }
      const active = await tx.reservationGroup.findFirst({
        where: {
          tenantId: ctx.tenantId,
          orderId: dto.orderId,
          status: RESERVATION_STATUS.ACTIVE,
        },
      });
      if (active) {
        throw new ConflictException(
          'Đơn đã có reservation khác đang hoạt động; cần đối soát trước',
        );
      }

      const balances = new Map<string, InventoryBalance>();
      const shortages: ReservationShortage[] = [];
      const lines = [...dto.lines].sort((a, b) =>
        a.productId.localeCompare(b.productId),
      );
      for (const line of lines) {
        await tx.$queryRaw(Prisma.sql`
          SELECT id FROM inventory.inventory_balances
          WHERE tenant_id = ${ctx.tenantId}::uuid
            AND warehouse_id = ${dto.warehouseId}::uuid AND product_id = ${line.productId}::uuid
          ORDER BY product_id FOR UPDATE
        `);
        const balance = await tx.inventoryBalance.findFirst({
          where: {
            tenantId: ctx.tenantId,
            warehouseId: dto.warehouseId,
            productId: line.productId,
            deletedAt: null,
          },
        });
        const available = balance
          ? balance.onHandQuantity.minus(balance.reservedQuantity)
          : new Prisma.Decimal(0);
        if (available.lessThan(line.quantity)) {
          shortages.push({
            productId: line.productId,
            required: new Prisma.Decimal(line.quantity).toFixed(3),
            available: available.toFixed(3),
          });
        }
        if (balance) balances.set(line.productId, balance);
      }
      if (shortages.length > 0) return { outcome: 'INSUFFICIENT', shortages };

      const group = await tx.reservationGroup.create({
        data: {
          tenantId: ctx.tenantId,
          orderId: dto.orderId,
          warehouseId: dto.warehouseId,
          orderVersion: BigInt(dto.orderVersion),
          idempotencyKey,
          status: RESERVATION_STATUS.ACTIVE,
        },
      });
      for (const line of lines) {
        const balance = balances.get(line.productId);
        if (!balance)
          throw new Error(
            'Balance missing after successful availability check',
          );
        const quantity = new Prisma.Decimal(line.quantity);
        await tx.inventoryBalance.update({
          where: { id: balance.id },
          data: {
            reservedQuantity: { increment: quantity },
            version: { increment: 1 },
          },
        });
        await tx.inventoryReservation.create({
          data: {
            tenantId: ctx.tenantId,
            reservationGroupId: group.id,
            orderId: dto.orderId,
            orderLineId: line.orderLineId,
            balanceId: balance.id,
            warehouseId: dto.warehouseId,
            productId: line.productId,
            quantity,
            status: RESERVATION_STATUS.ACTIVE,
          },
        });
      }
      await this.writeEvent(
        tx,
        group,
        RESERVATION_EVENT.RESERVED,
        ctx,
        lines.map((line) => ({
          productId: line.productId,
          quantity: new Prisma.Decimal(line.quantity).toFixed(3),
        })),
      );
      return toReserved(group);
    });
  }

  async release(
    orderId: string,
    ctx: ReservationContext,
    reservationGroupId?: string,
  ): Promise<{ outcome: 'RELEASED' }> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockOrder(tx, ctx.tenantId, orderId);
      const consumerName = 'inventory-order-cancellation';
      if (ctx.eventId) {
        const previous = await tx.inboxEvent.findUnique({
          where: {
            consumerName_eventId: { consumerName, eventId: ctx.eventId },
          },
        });
        if (previous) return { outcome: 'RELEASED' };
        await tx.inboxEvent.create({
          data: {
            tenantId: ctx.tenantId,
            consumerName,
            eventId: ctx.eventId,
            eventType: 'OrderCanceled',
            aggregateId: orderId,
            outcome: 'RELEASED',
          },
        });
      }
      const groups = await tx.reservationGroup.findMany({
        where: {
          tenantId: ctx.tenantId,
          orderId,
          status: RESERVATION_STATUS.ACTIVE,
          ...(reservationGroupId && { id: reservationGroupId }),
        },
        include: {
          reservations: { where: { status: RESERVATION_STATUS.ACTIVE } },
        },
        orderBy: { id: 'asc' },
      });
      const reservations = groups
        .flatMap((group) => group.reservations)
        .sort((a, b) => a.productId.localeCompare(b.productId));
      for (const reservation of reservations) {
        await tx.$queryRaw(Prisma.sql`
          SELECT id FROM inventory.inventory_balances
          WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${reservation.balanceId}::uuid
          FOR UPDATE
        `);
        const balance = await tx.inventoryBalance.findFirstOrThrow({
          where: { tenantId: ctx.tenantId, id: reservation.balanceId },
        });
        if (balance.reservedQuantity.lessThan(reservation.quantity)) {
          throw new ConflictException(
            'Reserved không đủ để giải phóng reservation; cần đối soát',
          );
        }
        await tx.inventoryBalance.update({
          where: { id: balance.id },
          data: {
            reservedQuantity: { decrement: reservation.quantity },
            version: { increment: 1 },
          },
        });
      }
      const releasedAt = new Date();
      for (const group of groups) {
        await tx.inventoryReservation.updateMany({
          where: {
            tenantId: ctx.tenantId,
            reservationGroupId: group.id,
            status: RESERVATION_STATUS.ACTIVE,
          },
          data: {
            status: RESERVATION_STATUS.RELEASED,
            releasedAt,
            version: { increment: 1 },
          },
        });
        const released = await tx.reservationGroup.update({
          where: { id: group.id },
          data: {
            status: RESERVATION_STATUS.RELEASED,
            releasedAt,
            version: { increment: 1 },
          },
        });
        await this.writeEvent(
          tx,
          released,
          RESERVATION_EVENT.RELEASED,
          ctx,
          group.reservations.map((line) => ({
            productId: line.productId,
            quantity: line.quantity.toFixed(3),
          })),
        );
      }
      return { outcome: 'RELEASED' };
    });
  }

  private async lockOrder(
    tx: Prisma.TransactionClient,
    tenantId: string,
    orderId: string,
  ): Promise<void> {
    // Serializes reserve/release even when no group exists, without locking another service's DB.
    await tx.$queryRaw(Prisma.sql`
      SELECT pg_advisory_xact_lock(hashtextextended(${`${tenantId}:${orderId}`}, 0))::text
    `);
  }

  private assertLines(dto: ReserveDto): void {
    if (
      dto.lines.length === 0 ||
      new Set(dto.lines.map((line) => line.productId)).size !==
        dto.lines.length ||
      new Set(dto.lines.map((line) => line.orderLineId)).size !==
        dto.lines.length ||
      dto.lines.some(
        (line) => !new Prisma.Decimal(line.quantity).greaterThan(0),
      )
    ) {
      throw new BadRequestException(
        'Dòng giữ hàng phải có số lượng dương và không trùng sản phẩm hoặc dòng đơn',
      );
    }
  }

  private async writeEvent(
    tx: Prisma.TransactionClient,
    group: ReservationGroup,
    eventType: string,
    ctx: ReservationContext,
    items: Array<{ productId: string; quantity: string }>,
  ): Promise<void> {
    await tx.outboxEvent.create({
      data: {
        tenantId: ctx.tenantId,
        eventType,
        eventVersion: 1,
        aggregateType: 'ReservationGroup',
        aggregateId: group.id,
        aggregateVersion: group.version,
        correlationId: ctx.correlationId,
        occurredAt: new Date(),
        payload: {
          reservationGroupId: group.id,
          orderId: group.orderId,
          orderVersion: group.orderVersion.toString(),
          warehouseId: group.warehouseId,
          items,
        },
      },
    });
  }
}
