import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type {
  ReservationPreview,
  ReserveRequest,
  ReservationShortage,
} from '@logix/messaging';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { ORDER_EVENT } from '../domain/order-constants.js';
import { ORDER_STATUS } from '../domain/order-status.js';
import { OrderErrors } from '../domain/order-errors.js';
import { InventoryClient } from '../integrations/inventory.client.js';
import {
  toOrderDetailView,
  type SalesOrderWithLines,
} from '../mappers/order.mapper.js';
import type { OrderCommandContext, OrderDetailView } from '../order.types.js';
import { OrderOutboxWriter } from '../outbox/order-outbox.writer.js';
import type { ReconcileReservationDto } from '../dto/reconcile-reservation.dto.js';
import { lockOrder } from './order-lock.js';

export const ORDER_RESERVATION_TRANSACTION_TIMEOUT_MS = 15_000;
type ReservationContext = Pick<
  OrderCommandContext,
  'tenantId' | 'correlationId'
> & {
  actorId: string | null;
  eventId?: string;
  eventType?: string;
};

@Injectable()
export class OrderReservationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryClient,
    private readonly outbox: OrderOutboxWriter,
  ) {}

  async reconcile(
    dto: ReconcileReservationDto,
    ctx: ReservationContext,
  ): Promise<{ decision: 'ACKNOWLEDGE' | 'RELEASE' | 'KEEP' }> {
    const order = await this.prisma.salesOrder.findFirst({
      where: { id: dto.orderId, tenantId: ctx.tenantId, deletedAt: null },
      include: { lines: true },
    });
    if (!order || order.status === ORDER_STATUS.CANCELED)
      return { decision: 'RELEASE' };
    if (order.cancellationRequestedAt) return { decision: 'KEEP' };
    if (order.reservationGroupId === dto.reservationGroupId)
      return { decision: 'ACKNOWLEDGE' };
    if (
      order.status !== ORDER_STATUS.DRAFT &&
      order.status !== ORDER_STATUS.PENDING_STOCK
    ) {
      return { decision: 'RELEASE' };
    }
    if (
      order.version !== BigInt(dto.orderVersion) ||
      order.warehouseId !== dto.warehouseId ||
      order.lines.length !== dto.lines.length ||
      dto.lines.some(
        (line) =>
          !order.lines.some(
            (saved) =>
              saved.id === line.orderLineId &&
              saved.productId === line.productId &&
              saved.quantity.equals(line.quantity),
          ),
      )
    )
      return { decision: 'RELEASE' };
    const recovered = await this.confirm(dto.orderId, dto.orderVersion, ctx);
    if (recovered.reservationGroupId !== dto.reservationGroupId) {
      throw new Error('Recovered order references a different reservation');
    }
    return { decision: 'ACKNOWLEDGE' };
  }

  async preview(
    orderId: string,
    ctx: ReservationContext,
  ): Promise<ReservationPreview & { version: number }> {
    const order = await this.load(this.prisma, ctx.tenantId, orderId);
    this.assertConfirmable(order);
    const preview = await this.inventory.preview(this.request(order), ctx);
    return { ...preview, version: Number(order.version) };
  }

  async shortages(tenantId: string, orderId: string) {
    await this.load(this.prisma, tenantId, orderId);
    const rows = await this.prisma.orderShortage.findMany({
      where: { tenantId, orderId, resolvedAt: null, deletedAt: null },
      orderBy: [{ detectedAt: 'desc' }, { productId: 'asc' }],
    });
    return rows.map((row) => ({
      id: row.id,
      productId: row.productId,
      warehouseId: row.warehouseId,
      required: row.requiredQuantity.toFixed(3),
      available: row.availableQuantity.toFixed(3),
      detectedAt: row.detectedAt,
    }));
  }

  async confirm(
    orderId: string,
    expectedVersion: number,
    ctx: ReservationContext,
    retryOnly = false,
  ): Promise<OrderDetailView> {
    const order = await this.prisma.$transaction(
      async (tx) => {
        await lockOrder(tx, ctx.tenantId, orderId);
        const current = await this.load(tx, ctx.tenantId, orderId);
        const consumerName = `order-reservation:${orderId}`;
        if (ctx.eventId) {
          const handled = await tx.inboxEvent.findUnique({
            where: {
              consumerName_eventId: { consumerName, eventId: ctx.eventId },
            },
          });
          if (handled) return current;
        }
        this.assertConfirmable(current, retryOnly);
        if (current.version !== BigInt(expectedVersion)) {
          throw OrderErrors.versionConflict(
            orderId,
            expectedVersion,
            Number(current.version),
          );
        }
        const result = await this.inventory.reserve(this.request(current), ctx);
        const occurredAt = new Date();
        const status =
          result.outcome === 'RESERVED'
            ? ORDER_STATUS.CONFIRMED
            : ORDER_STATUS.PENDING_STOCK;
        const pendingSince = current.pendingSince ?? occurredAt;
        const updated = await tx.salesOrder.update({
          where: { id: current.id, tenantId: ctx.tenantId },
          data: {
            status,
            version: { increment: 1 },
            ...(result.outcome === 'RESERVED'
              ? {
                  confirmedAt: occurredAt,
                  reservationGroupId: result.reservationGroupId,
                }
              : { pendingSince }),
          },
          include: { lines: true },
        });
        if (result.outcome === 'RESERVED') {
          await tx.orderShortage.updateMany({
            where: {
              tenantId: ctx.tenantId,
              orderId,
              resolvedAt: null,
              deletedAt: null,
            },
            data: { resolvedAt: occurredAt, version: { increment: 1 } },
          });
          const detail = toOrderDetailView(updated);
          await this.outbox.write(tx, {
            tenantId: ctx.tenantId,
            eventType: ORDER_EVENT.CONFIRMED,
            orderId,
            orderVersion: updated.version,
            correlationId: ctx.correlationId,
            occurredAt,
            actorId: ctx.actorId,
            causationId: ctx.eventId,
            payload: {
              orderId,
              orderNumber: updated.orderNumber,
              orderVersion: Number(updated.version),
              reservationGroupId: result.reservationGroupId,
              confirmedAt: occurredAt.toISOString(),
              customerId: detail.customerId,
              deliveryAddressId: detail.deliveryAddressId,
              warehouseId: detail.warehouseId,
              customerSnapshot: detail.customerSnapshot,
              deliveryAddressSnapshot: detail.deliveryAddressSnapshot,
              warehouseSnapshot: detail.warehouseSnapshot,
              totalQuantity: detail.totalQuantity,
              totalWeight: detail.totalWeight,
              totalVolume: detail.totalVolume,
              orderLines: detail.lines.map((line) => ({
                orderLineId: line.id,
                lineNumber: line.lineNumber,
                productId: line.productId,
                quantity: line.quantity,
                skuSnapshot: line.skuSnapshot,
                productNameSnapshot: line.productNameSnapshot,
                unitSnapshot: line.unitSnapshot,
                unitWeight: line.unitWeight,
                unitVolume: line.unitVolume,
              })),
            },
          });
        } else {
          await this.saveShortages(tx, updated, result.shortages, occurredAt);
          if (current.status !== ORDER_STATUS.PENDING_STOCK)
            await this.outbox.write(tx, {
              tenantId: ctx.tenantId,
              eventType: ORDER_EVENT.PENDING_STOCK,
              orderId,
              orderVersion: updated.version,
              correlationId: ctx.correlationId,
              occurredAt,
              actorId: ctx.actorId,
              causationId: ctx.eventId,
              payload: {
                orderId,
                warehouseId: updated.warehouseId,
                pendingSince: pendingSince.toISOString(),
                shortageItems: result.shortages.map((item) => ({
                  productId: item.productId,
                  requestedQuantity: item.required,
                  availableQuantity: item.available,
                })),
              },
            });
        }
        if (current.status !== status) {
          await tx.orderStatusHistory.create({
            data: {
              tenantId: ctx.tenantId,
              orderId,
              fromStatus: current.status,
              toStatus: status,
              actorId: ctx.actorId,
              correlationId: ctx.correlationId,
              orderVersion: updated.version,
              occurredAt,
            },
          });
        }
        if (ctx.eventId) {
          await tx.inboxEvent.create({
            data: {
              tenantId: ctx.tenantId,
              consumerName,
              eventId: ctx.eventId,
              eventType: ctx.eventType ?? 'InventoryAvailabilityChanged',
              aggregateId: orderId,
              aggregateVersion: updated.version,
              outcome: result.outcome,
            },
          });
        }
        return updated;
      },
      { timeout: ORDER_RESERVATION_TRANSACTION_TIMEOUT_MS },
    );
    return toOrderDetailView(order);
  }

  private async saveShortages(
    tx: Prisma.TransactionClient,
    order: SalesOrderWithLines,
    items: ReservationShortage[],
    detectedAt: Date,
  ): Promise<void> {
    const hashes: string[] = [];
    for (const item of items) {
      const shortageHash = createHash('sha256')
        .update(
          JSON.stringify([
            order.id,
            order.warehouseId,
            item.productId,
            item.required,
            item.available,
          ]),
        )
        .digest('hex');
      hashes.push(shortageHash);
      const existing = await tx.orderShortage.findFirst({
        where: {
          tenantId: order.tenantId,
          orderId: order.id,
          shortageHash,
          resolvedAt: null,
          deletedAt: null,
        },
      });
      const data = {
        requiredQuantity: item.required,
        availableQuantity: item.available,
        detectedAt,
        version: { increment: 1 },
      };
      if (existing) {
        await tx.orderShortage.update({
          where: { id: existing.id, tenantId: order.tenantId },
          data,
        });
      } else {
        await tx.orderShortage.create({
          data: {
            tenantId: order.tenantId,
            orderId: order.id,
            warehouseId: order.warehouseId,
            productId: item.productId,
            requiredQuantity: item.required,
            availableQuantity: item.available,
            shortageHash,
            detectedAt,
          },
        });
      }
    }
    await tx.orderShortage.updateMany({
      where: {
        tenantId: order.tenantId,
        orderId: order.id,
        resolvedAt: null,
        deletedAt: null,
        shortageHash: { notIn: hashes },
      },
      data: { resolvedAt: detectedAt, version: { increment: 1 } },
    });
  }

  private request(order: SalesOrderWithLines): ReserveRequest {
    return {
      orderId: order.id,
      orderVersion: Number(order.version),
      warehouseId: order.warehouseId,
      lines: order.lines.map((line) => ({
        orderLineId: line.id,
        productId: line.productId,
        quantity: line.quantity.toFixed(3),
      })),
    };
  }

  private assertConfirmable(
    order: SalesOrderWithLines,
    retryOnly = false,
  ): void {
    if (order.cancellationRequestedAt) {
      throw OrderErrors.invalidTransition(
        order.id,
        order.status,
        'CANCELLATION_PENDING',
      );
    }
    if (
      order.status !== ORDER_STATUS.PENDING_STOCK &&
      (retryOnly || order.status !== ORDER_STATUS.DRAFT)
    ) {
      throw OrderErrors.invalidTransition(
        order.id,
        order.status,
        retryOnly ? 'RETRY_RESERVATION' : 'CONFIRM',
      );
    }
  }

  private async load(
    client: PrismaService | Prisma.TransactionClient,
    tenantId: string,
    orderId: string,
  ) {
    const order = await client.salesOrder.findFirst({
      where: { id: orderId, tenantId, deletedAt: null },
      include: { lines: true },
    });
    if (!order) throw OrderErrors.notFound(orderId);
    return order;
  }
}
