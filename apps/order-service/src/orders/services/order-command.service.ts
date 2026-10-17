import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type {
  AddressSnapshot,
  CustomerSnapshot,
  WarehouseSnapshot,
} from '@logix/messaging';
import { Prisma, type SalesOrder } from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import {
  IDEMPOTENCY_KEY_PATTERN,
  ORDER_CANCELABLE_STATUSES,
  ORDER_EDITABLE_STATUSES,
  ORDER_EVENT,
  ORDER_SOURCE,
} from '../domain/order-constants.js';
import { OrderErrors } from '../domain/order-errors.js';
import { ORDER_STATUS, type OrderStatus } from '../domain/order-status.js';
import { canTransition } from '../domain/order-state-machine.js';
import type { CancelOrderDto } from '../dto/cancel-order.dto.js';
import type { CreateOrderDto } from '../dto/create-order.dto.js';
import type { UpdateOrderDto } from '../dto/update-order.dto.js';
import type { MasterDataRequestContext } from '../integrations/master-data.types.js';
import {
  toOrderDetailView,
  toOrderDraftPayload,
  type SalesOrderWithLines,
} from '../mappers/order.mapper.js';
import type {
  CreateOrderResult,
  OrderCommandContext,
  OrderDetailView,
} from '../order.types.js';
import { OrderOutboxWriter } from '../outbox/order-outbox.writer.js';
import { OrderNumberService } from './order-number.service.js';
import {
  OrderReferenceResolver,
  type ResolvedOrderLine,
} from './order-reference.resolver.js';
import { calculateOrderTotals } from './order-totals.js';
import { InventoryClient } from '../integrations/inventory.client.js';
import { ORDER_RESERVATION_TRANSACTION_TIMEOUT_MS } from './order-reservation.service.js';
import { lockOrder } from './order-lock.js';

const UNIQUE_VIOLATION = 'P2002';
const ORDER_ACTION = {
  UPDATE: 'UPDATE',
  CANCEL: 'CANCEL',
} as const;

type OrderAction = (typeof ORDER_ACTION)[keyof typeof ORDER_ACTION];
type Tx = Prisma.TransactionClient;

const toSnapshotJson = (
  snapshot: CustomerSnapshot | AddressSnapshot | WarehouseSnapshot,
): Prisma.InputJsonObject => snapshot as unknown as Prisma.InputJsonObject;

/**
 * Deterministic SHA-256 over the business content of a create request. Key
 * order is fixed and quantities are normalized, so semantically equal bodies
 * always hash identically.
 */
export function hashCreateOrderRequest(dto: CreateOrderDto): string {
  const normalized = {
    customerId: dto.customerId.toLowerCase(),
    deliveryAddressId: dto.deliveryAddressId.toLowerCase(),
    warehouseId: dto.warehouseId.toLowerCase(),
    currency: dto.currency,
    lines: dto.lines.map((line) => ({
      productId: line.productId.toLowerCase(),
      quantity: new Prisma.Decimal(line.quantity).toFixed(),
    })),
  };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function toLineCreateData(tenantId: string, line: ResolvedOrderLine) {
  return {
    tenantId,
    lineNumber: line.lineNumber,
    productId: line.productId,
    skuSnapshot: line.skuSnapshot,
    productNameSnapshot: line.productNameSnapshot,
    unitSnapshot: line.unitSnapshot,
    quantity: line.quantity,
    unitWeight: line.unitWeight,
    unitVolume: line.unitVolume,
  };
}

function hasUpdatableField(dto: UpdateOrderDto): boolean {
  return (
    dto.customerId !== undefined ||
    dto.deliveryAddressId !== undefined ||
    dto.warehouseId !== undefined ||
    dto.currency !== undefined ||
    dto.lines !== undefined
  );
}

@Injectable()
export class OrderCommandService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly references: OrderReferenceResolver,
    private readonly orderNumbers: OrderNumberService,
    private readonly outbox: OrderOutboxWriter,
    private readonly inventory: InventoryClient,
  ) {}

  async create(
    dto: CreateOrderDto,
    idempotencyKey: string | undefined,
    ctx: OrderCommandContext,
  ): Promise<CreateOrderResult> {
    if (!idempotencyKey || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      throw OrderErrors.idempotencyKeyRequired();
    }
    const requestHash = hashCreateOrderRequest(dto);

    const existing = await this.findByIdempotencyKey(
      ctx.tenantId,
      idempotencyKey,
    );
    if (existing) {
      return this.replay(existing, requestHash);
    }

    this.references.assertLineRules(dto.lines);
    const upstream = this.toUpstreamContext(ctx);
    const [customer, warehouseSnapshot, lines] = await Promise.all([
      this.references.resolveCustomer(
        dto.customerId,
        dto.deliveryAddressId,
        upstream,
      ),
      this.references.resolveWarehouse(dto.warehouseId, upstream),
      this.references.resolveLines(dto.lines, upstream),
    ]);
    const totals = calculateOrderTotals(lines);

    try {
      const order = await this.prisma.$transaction(async (tx) => {
        const occurredAt = new Date();
        const orderNumber = await this.orderNumbers.next(
          tx,
          ctx.tenantId,
          occurredAt,
        );
        const created = await tx.salesOrder.create({
          data: {
            tenantId: ctx.tenantId,
            orderNumber,
            customerId: dto.customerId,
            deliveryAddressId: dto.deliveryAddressId,
            warehouseId: dto.warehouseId,
            customerSnapshot: toSnapshotJson(customer.customerSnapshot),
            deliveryAddressSnapshot: toSnapshotJson(
              customer.deliveryAddressSnapshot,
            ),
            warehouseSnapshot: toSnapshotJson(warehouseSnapshot),
            currency: dto.currency,
            status: ORDER_STATUS.DRAFT,
            orderSource: ORDER_SOURCE.MANUAL,
            idempotencyKey,
            idempotencyRequestHash: requestHash,
            ...totals,
            lines: {
              create: lines.map((line) => toLineCreateData(ctx.tenantId, line)),
            },
          },
          include: { lines: true },
        });

        await tx.orderStatusHistory.create({
          data: {
            tenantId: ctx.tenantId,
            orderId: created.id,
            fromStatus: null,
            toStatus: ORDER_STATUS.DRAFT,
            actorId: ctx.actorId,
            correlationId: ctx.correlationId,
            orderVersion: created.version,
            occurredAt,
          },
        });

        await this.outbox.write(tx, {
          tenantId: ctx.tenantId,
          eventType: ORDER_EVENT.CREATED,
          actorId: ctx.actorId,
          orderId: created.id,
          orderVersion: created.version,
          correlationId: ctx.correlationId,
          occurredAt,
          payload: toOrderDraftPayload(created),
        });

        return created;
      });
      return { order: toOrderDetailView(order), replayed: false };
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        // A concurrent request with the same key committed first.
        const winner = await this.findByIdempotencyKey(
          ctx.tenantId,
          idempotencyKey,
        );
        if (winner) {
          return this.replay(winner, requestHash);
        }
      }
      throw error;
    }
  }

  async update(
    orderId: string,
    dto: UpdateOrderDto,
    ctx: OrderCommandContext,
  ): Promise<OrderDetailView> {
    if (!hasUpdatableField(dto)) {
      throw OrderErrors.noChanges();
    }

    const current = await this.loadOrder(this.prisma, ctx.tenantId, orderId);
    this.assertWritable(
      current,
      dto.version,
      ORDER_ACTION.UPDATE,
      ORDER_EDITABLE_STATUSES,
    );

    const customerId = dto.customerId ?? current.customerId;
    const deliveryAddressId =
      dto.deliveryAddressId ?? current.deliveryAddressId;
    const customerChanged =
      dto.customerId !== undefined || dto.deliveryAddressId !== undefined;
    if (dto.lines) {
      this.references.assertLineRules(dto.lines);
    }

    const upstream = this.toUpstreamContext(ctx);
    const [customer, warehouseSnapshot, lines] = await Promise.all([
      customerChanged
        ? this.references.resolveCustomer(
            customerId,
            deliveryAddressId,
            upstream,
          )
        : undefined,
      dto.warehouseId
        ? this.references.resolveWarehouse(dto.warehouseId, upstream)
        : undefined,
      dto.lines ? this.references.resolveLines(dto.lines, upstream) : undefined,
    ]);

    const data: Prisma.SalesOrderUpdateManyMutationInput = {
      version: { increment: 1 },
      ...(dto.currency !== undefined && { currency: dto.currency }),
      ...(customer && {
        customerId,
        deliveryAddressId,
        customerSnapshot: toSnapshotJson(customer.customerSnapshot),
        deliveryAddressSnapshot: toSnapshotJson(
          customer.deliveryAddressSnapshot,
        ),
      }),
      ...(warehouseSnapshot && {
        warehouseId: dto.warehouseId,
        warehouseSnapshot: toSnapshotJson(warehouseSnapshot),
      }),
      ...(lines && calculateOrderTotals(lines)),
    };

    const updated = await this.prisma.$transaction(
      async (tx) => {
        await lockOrder(tx, ctx.tenantId, orderId);
        const locked = await this.loadOrder(tx, ctx.tenantId, orderId);
        this.assertWritable(
          locked,
          dto.version,
          ORDER_ACTION.UPDATE,
          ORDER_EDITABLE_STATUSES,
        );
        const active = await this.inventory.active(orderId, ctx);
        if (active.reservationGroupId) {
          throw OrderErrors.invalidTransition(
            orderId,
            locked.status,
            'RESERVATION_RECONCILIATION_REQUIRED',
          );
        }
        if (
          locked.status === ORDER_STATUS.PENDING_STOCK &&
          (dto.lines || dto.warehouseId)
        ) {
          data.pendingSince = new Date();
          await tx.orderShortage.updateMany({
            where: {
              tenantId: ctx.tenantId,
              orderId,
              resolvedAt: null,
              deletedAt: null,
            },
            data: { resolvedAt: new Date(), version: { increment: 1 } },
          });
        }
        await this.guardedUpdate(
          tx,
          ctx.tenantId,
          orderId,
          dto.version,
          ORDER_ACTION.UPDATE,
          ORDER_EDITABLE_STATUSES,
          data,
        );

        if (lines) {
          // Lines are replaced wholesale: (tenant, order, product) is unique, so
          // re-creating avoids transient collisions when products are reordered.
          await tx.orderLine.deleteMany({
            where: { tenantId: ctx.tenantId, orderId },
          });
          await tx.orderLine.createMany({
            data: lines.map((line) => ({
              ...toLineCreateData(ctx.tenantId, line),
              orderId,
            })),
          });
        }

        const order = await this.loadOrder(tx, ctx.tenantId, orderId);
        await this.outbox.write(tx, {
          tenantId: ctx.tenantId,
          eventType: ORDER_EVENT.UPDATED,
          actorId: ctx.actorId,
          orderId,
          orderVersion: order.version,
          correlationId: ctx.correlationId,
          occurredAt: order.updatedAt,
          payload: toOrderDraftPayload(order),
        });
        return order;
      },
      { timeout: ORDER_RESERVATION_TRANSACTION_TIMEOUT_MS },
    );

    return toOrderDetailView(updated);
  }

  async cancel(
    orderId: string,
    dto: CancelOrderDto,
    ctx: OrderCommandContext,
  ): Promise<OrderDetailView> {
    await this.prisma.$transaction(async (tx) => {
      await lockOrder(tx, ctx.tenantId, orderId);
      const current = await this.loadOrder(tx, ctx.tenantId, orderId);
      this.assertWritable(
        current,
        dto.version,
        ORDER_ACTION.CANCEL,
        ORDER_CANCELABLE_STATUSES,
      );
      await tx.salesOrder.update({
        where: { id: orderId, tenantId: ctx.tenantId },
        data: {
          cancellationRequestedAt: new Date(),
          cancellationReason: dto.reason,
          cancellationActorId: ctx.actorId,
          cancellationCorrelationId: ctx.correlationId,
          version: { increment: 1 },
        },
      });
    });
    return this.completeCancellation(ctx.tenantId, orderId);
  }

  async completeCancellation(
    tenantId: string,
    orderId: string,
  ): Promise<OrderDetailView> {
    const intent = await this.loadOrder(this.prisma, tenantId, orderId);
    if (intent.dispatchGrantedAt) throw OrderErrors.dispatchCommitted(orderId);
    if (intent.status === ORDER_STATUS.CANCELED)
      return toOrderDetailView(intent);
    if (
      !intent.cancellationRequestedAt ||
      !intent.cancellationReason ||
      !intent.cancellationCorrelationId
    ) {
      throw OrderErrors.invalidTransition(
        orderId,
        intent.status,
        'NO_CANCELLATION_REQUEST',
      );
    }
    const ctx = {
      tenantId,
      actorId: intent.cancellationActorId,
      correlationId: intent.cancellationCorrelationId,
    };
    await this.inventory.release(orderId, ctx);
    const canceled = await this.prisma.$transaction(async (tx) => {
      await lockOrder(tx, tenantId, orderId);
      const current = await this.loadOrder(tx, tenantId, orderId);
      if (current.dispatchGrantedAt) throw OrderErrors.dispatchCommitted(orderId);
      if (current.status === ORDER_STATUS.CANCELED) return current;
      if (!current.cancellationRequestedAt || !current.cancellationReason) {
        throw OrderErrors.invalidTransition(
          orderId,
          current.status,
          'NO_CANCELLATION_REQUEST',
        );
      }
      const canceledAt = new Date();
      await tx.salesOrder.update({
        where: { id: orderId, tenantId },
        data: {
          status: ORDER_STATUS.CANCELED,
          canceledAt,
          cancelReason: current.cancellationReason,
          cancellationRequestedAt: null,
          version: { increment: 1 },
        },
      });
      await tx.orderShortage.updateMany({
        where: { tenantId, orderId, resolvedAt: null, deletedAt: null },
        data: { resolvedAt: canceledAt, version: { increment: 1 } },
      });

      const order = await this.loadOrder(tx, ctx.tenantId, orderId);
      await tx.orderStatusHistory.create({
        data: {
          tenantId: ctx.tenantId,
          orderId,
          fromStatus: current.status,
          toStatus: ORDER_STATUS.CANCELED,
          reason: current.cancellationReason,
          actorId: ctx.actorId,
          correlationId: ctx.correlationId,
          orderVersion: order.version,
          occurredAt: canceledAt,
        },
      });
      await this.outbox.write(tx, {
        tenantId: ctx.tenantId,
        eventType: ORDER_EVENT.CANCELED,
        actorId: ctx.actorId,
        orderId,
        orderVersion: order.version,
        correlationId: ctx.correlationId,
        occurredAt: canceledAt,
        payload: {
          orderId,
          orderNumber: order.orderNumber,
          previousStatus: current.status,
          canceledAt: canceledAt.toISOString(),
          reason: current.cancellationReason,
        },
      });
      return order;
    });

    return toOrderDetailView(canceled);
  }

  private async findByIdempotencyKey(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<SalesOrderWithLines | null> {
    return this.prisma.salesOrder.findFirst({
      where: { tenantId, idempotencyKey },
      include: { lines: true },
    });
  }

  private replay(
    order: SalesOrderWithLines,
    requestHash: string,
  ): CreateOrderResult {
    if (order.idempotencyRequestHash !== requestHash) {
      throw OrderErrors.idempotencyKeyReused();
    }
    return { order: toOrderDetailView(order), replayed: true };
  }

  private async loadOrder(
    client: Tx | PrismaService,
    tenantId: string,
    orderId: string,
  ): Promise<SalesOrderWithLines> {
    const order = await client.salesOrder.findFirst({
      where: { id: orderId, tenantId, deletedAt: null },
      include: { lines: true },
    });
    if (!order) {
      throw OrderErrors.notFound(orderId);
    }
    return order;
  }

  /** Status is checked before version so a stale client still learns the order is locked. */
  private assertWritable(
    order: SalesOrder,
    expectedVersion: number,
    action: OrderAction,
    allowedStatuses: readonly OrderStatus[],
  ): void {
    if (order.dispatchGrantedAt) {
      throw OrderErrors.dispatchCommitted(order.id);
    }
    if (order.cancellationRequestedAt) {
      throw OrderErrors.invalidTransition(
        order.id,
        order.status,
        'CANCELLATION_PENDING',
      );
    }
    const status = order.status as OrderStatus;
    const transitionAllowed =
      action !== ORDER_ACTION.CANCEL ||
      canTransition(status, ORDER_STATUS.CANCELED);
    if (!allowedStatuses.includes(status) || !transitionAllowed) {
      throw OrderErrors.invalidTransition(order.id, status, action);
    }
    if (order.version !== BigInt(expectedVersion)) {
      throw OrderErrors.versionConflict(
        order.id,
        expectedVersion,
        Number(order.version),
      );
    }
  }

  /**
   * Optimistic write: the WHERE clause re-checks version and status, so a
   * concurrent writer that slipped in after the pre-check is detected here.
   */
  private async guardedUpdate(
    tx: Tx,
    tenantId: string,
    orderId: string,
    expectedVersion: number,
    action: OrderAction,
    allowedStatuses: readonly OrderStatus[],
    data: Prisma.SalesOrderUpdateManyMutationInput,
  ): Promise<void> {
    const { count } = await tx.salesOrder.updateMany({
      where: {
        id: orderId,
        tenantId,
        deletedAt: null,
        version: BigInt(expectedVersion),
        status: { in: [...allowedStatuses] },
      },
      data,
    });
    if (count === 0) {
      const latest = await this.loadOrder(tx, tenantId, orderId);
      this.assertWritable(latest, expectedVersion, action, allowedStatuses);
      throw OrderErrors.versionConflict(
        orderId,
        expectedVersion,
        Number(latest.version),
      );
    }
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === UNIQUE_VIOLATION
    );
  }

  private toUpstreamContext(
    ctx: OrderCommandContext,
  ): MasterDataRequestContext {
    return {
      authorization: ctx.authorization,
      correlationId: ctx.correlationId,
    };
  }

}
