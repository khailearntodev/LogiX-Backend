import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import {
  INVENTORY_EVENT_VERSION,
  InventoryEventType,
  MovementType,
  type ReferenceType,
} from '../inventory.constants.js';
import { toMovementView } from '../inventory.mappers.js';
import type { StockMovementView } from '../inventory.types.js';

export interface ApplyMovementCommand {
  tenantId: string;
  warehouseId: string;
  productId: string;
  movementType: MovementType;
  /** Signed Decimal(18,3) as string. */
  quantityDelta: string;
  referenceType: ReferenceType;
  referenceId: string;
  idempotencyKey: string;
  reason?: string | null;
  actorId: string;
  correlationId: string;
  occurredAt: Date;
}

const UNIQUE_VIOLATION = 'P2002';

/**
 * The only write primitive for on-hand quantity: locks the balance row, writes
 * one StockMovement and one OutboxEvent in the same transaction, and replays
 * safely on a duplicate idempotencyKey.
 */
@Injectable()
export class StockMovementService {
  constructor(private readonly prisma: PrismaService) {}

  async applyMovement(command: ApplyMovementCommand): Promise<StockMovementView> {
    try {
      return await this.prisma.$transaction((tx) =>
        this.applyMovementInTransaction(tx, command),
      );
    } catch (error) {
      // Two concurrent requests with the same key: the loser returns the winner's result.
      const replay = await this.findByIdempotencyKey(
        command.tenantId,
        command.idempotencyKey,
      );
      if (replay && this.isUniqueViolation(error)) {
        return replay;
      }
      throw error;
    }
  }

  /** Same contract as applyMovement but joins a caller-owned transaction. */
  async applyMovementInTransaction(
    tx: Prisma.TransactionClient,
    command: ApplyMovementCommand,
  ): Promise<StockMovementView> {
    const existing = await tx.stockMovement.findFirst({
      where: { tenantId: command.tenantId, idempotencyKey: command.idempotencyKey },
    });
    if (existing) {
      return toMovementView(existing);
    }

    const delta = new Prisma.Decimal(command.quantityDelta);
    if (delta.isZero()) {
      throw new BadRequestException('Số lượng thay đổi phải khác 0');
    }

    const isAdjustment = command.movementType.startsWith('ADJUSTMENT');
    if (isAdjustment && !command.reason?.trim()) {
      throw new BadRequestException('Điều chỉnh tồn kho bắt buộc phải có lý do');
    }

    const balance = await this.lockBalance(
      tx,
      command.tenantId,
      command.warehouseId,
      command.productId,
    );

    const beforeOnHand = balance.onHandQuantity;
    const afterOnHand = beforeOnHand.plus(delta);

    if (afterOnHand.isNegative()) {
      throw new BadRequestException(
        `Tồn kho không đủ: hiện có ${beforeOnHand.toFixed(3)}, yêu cầu giảm ${delta.abs().toFixed(3)}`,
      );
    }

    if (afterOnHand.lessThan(balance.reservedQuantity)) {
      throw new BadRequestException(
        `Không thể giảm tồn kho xuống dưới số lượng đang giữ chỗ (${balance.reservedQuantity.toFixed(3)})`,
      );
    }

    const updatedBalance = await tx.inventoryBalance.update({
      where: { id: balance.id },
      data: {
        onHandQuantity: afterOnHand,
        version: { increment: 1 },
      },
    });

    const movement = await tx.stockMovement.create({
      data: {
        tenantId: command.tenantId,
        warehouseId: command.warehouseId,
        productId: command.productId,
        balanceId: balance.id,
        movementType: command.movementType,
        quantityDelta: delta,
        beforeOnHand,
        afterOnHand,
        referenceType: command.referenceType,
        referenceId: command.referenceId,
        idempotencyKey: command.idempotencyKey,
        reason: command.reason ?? null,
        actorId: command.actorId,
        correlationId: command.correlationId,
        occurredAt: command.occurredAt,
      },
    });

    await tx.outboxEvent.create({
      data: {
        tenantId: command.tenantId,
        eventType:
          command.movementType === MovementType.RECEIPT
            ? InventoryEventType.STOCK_RECEIVED
            : InventoryEventType.INVENTORY_ADJUSTED,
        eventVersion: INVENTORY_EVENT_VERSION,
        aggregateType: 'InventoryBalance',
        aggregateId: balance.id,
        aggregateVersion: updatedBalance.version,
        correlationId: command.correlationId,
        payload: {
          movementId: movement.id,
          warehouseId: command.warehouseId,
          productId: command.productId,
          movementType: command.movementType,
          quantityDelta: delta.toFixed(3),
          beforeOnHand: beforeOnHand.toFixed(3),
          afterOnHand: afterOnHand.toFixed(3),
          reservedQuantity: updatedBalance.reservedQuantity.toFixed(3),
          referenceType: command.referenceType,
          referenceId: command.referenceId,
          reason: command.reason ?? null,
          actorId: command.actorId,
        },
        occurredAt: command.occurredAt,
      },
    });

    return toMovementView(movement);
  }

  /**
   * Creates the balance on first movement, then takes a row lock so concurrent
   * movements on the same warehouse-SKU serialize instead of racing.
   */
  private async lockBalance(
    tx: Prisma.TransactionClient,
    tenantId: string,
    warehouseId: string,
    productId: string,
  ) {
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO inventory.inventory_balances (
        id, tenant_id, warehouse_id, product_id,
        on_hand_quantity, reserved_quantity, low_stock_threshold,
        created_at, updated_at
      )
      VALUES (
        gen_random_uuid(), ${tenantId}::uuid, ${warehouseId}::uuid, ${productId}::uuid,
        0, 0, 0,
        now(), now()
      )
      ON CONFLICT (tenant_id, warehouse_id, product_id) DO NOTHING
    `);

    await tx.$queryRaw(Prisma.sql`
      SELECT id
      FROM inventory.inventory_balances
      WHERE tenant_id = ${tenantId}::uuid
        AND warehouse_id = ${warehouseId}::uuid
        AND product_id = ${productId}::uuid
      FOR UPDATE
    `);

    // Typed re-read under the lock; the raw select above only acquires it.
    return tx.inventoryBalance.findFirstOrThrow({
      where: { tenantId, warehouseId, productId },
    });
  }

  private async findByIdempotencyKey(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<StockMovementView | null> {
    const row = await this.prisma.stockMovement.findFirst({
      where: { tenantId, idempotencyKey },
    });
    return row ? toMovementView(row) : null;
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === UNIQUE_VIOLATION
    );
  }
}
