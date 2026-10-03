import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../database/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import { CreateStockReceiptDto } from '../dto/create-stock-receipt.dto.js';
import { AdjustStockDto } from '../dto/adjust-stock.dto.js';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface.js';
import {
  MovementType,
  ReceiptStatus,
  ReferenceType,
} from '../inventory.constants.js';
import { toBalanceView } from '../inventory.mappers.js';
import type { InventoryBalanceView, StockReceiptView } from '../inventory.types.js';
import { StockMovementService } from './stock-movement.service.js';

const UNIQUE_VIOLATION = 'P2002';

@Injectable()
export class StockReceiptService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stockMovement: StockMovementService,
  ) {}

  /** All lines succeed or none: one transaction over header, lines and movements. */
  async createReceipt(
    actor: AuthenticatedUser,
    dto: CreateStockReceiptDto,
  ): Promise<StockReceiptView> {
    const existing = await this.findReceiptByIdempotencyKey(
      actor.tenantId,
      dto.idempotencyKey,
    );
    if (existing) {
      return existing;
    }

    this.assertNoDuplicateProduct(dto);

    const receivedAt = dto.receivedAt ? new Date(dto.receivedAt) : new Date();
    const correlationId = randomUUID();

    try {
      const receiptId = await this.prisma.$transaction(async (tx) => {
        const receipt = await tx.stockReceipt.create({
          data: {
            tenantId: actor.tenantId,
            receiptNumber: dto.receiptNumber?.trim() || this.generateReceiptNumber(),
            warehouseId: dto.warehouseId,
            idempotencyKey: dto.idempotencyKey,
            status: ReceiptStatus.POSTED,
            receivedAt,
            actorId: actor.id,
            correlationId,
          },
        });

        for (const [index, line] of dto.lines.entries()) {
          const movement = await this.stockMovement.applyMovementInTransaction(tx, {
            tenantId: actor.tenantId,
            warehouseId: dto.warehouseId,
            productId: line.productId,
            movementType: MovementType.RECEIPT,
            quantityDelta: line.quantity,
            referenceType: ReferenceType.STOCK_RECEIPT,
            referenceId: receipt.id,
            // Derived from the receipt key so a replayed receipt replays every line.
            idempotencyKey: `${dto.idempotencyKey}:${index}`,
            actorId: actor.id,
            correlationId,
            occurredAt: receivedAt,
          });

          await tx.stockReceiptLine.create({
            data: {
              tenantId: actor.tenantId,
              receiptId: receipt.id,
              productId: line.productId,
              quantity: new Prisma.Decimal(line.quantity),
              movementId: movement.id,
            },
          });
        }

        return receipt.id;
      });

      return this.getReceipt(actor.tenantId, receiptId);
    } catch (error) {
      const replay = await this.findReceiptByIdempotencyKey(
        actor.tenantId,
        dto.idempotencyKey,
      );
      if (replay && this.isUniqueViolation(error)) {
        return replay;
      }
      throw error;
    }
  }

  async adjustStock(
    actor: AuthenticatedUser,
    warehouseId: string,
    productId: string,
    dto: AdjustStockDto,
  ): Promise<InventoryBalanceView> {
    await this.stockMovement.applyMovement({
      tenantId: actor.tenantId,
      warehouseId,
      productId,
      movementType: new Prisma.Decimal(dto.quantityDelta).isNegative()
        ? MovementType.ADJUSTMENT_OUT
        : MovementType.ADJUSTMENT_IN,
      quantityDelta: dto.quantityDelta,
      referenceType: ReferenceType.MANUAL_ADJUSTMENT,
      // Manual adjustment has no upstream document, so the actor is the reference.
      referenceId: actor.id,
      idempotencyKey: dto.idempotencyKey,
      reason: dto.reason,
      actorId: actor.id,
      correlationId: randomUUID(),
      occurredAt: new Date(),
    });

    const balance = await this.prisma.inventoryBalance.findFirstOrThrow({
      where: { tenantId: actor.tenantId, warehouseId, productId },
    });

    return toBalanceView(balance);
  }

  private async getReceipt(
    tenantId: string,
    receiptId: string,
  ): Promise<StockReceiptView> {
    const receipt = await this.prisma.stockReceipt.findFirst({
      where: { id: receiptId, tenantId, deletedAt: null },
      include: { lines: { orderBy: { createdAt: 'asc' } } },
    });

    if (!receipt) {
      throw new NotFoundException('Không tìm thấy phiếu nhập kho');
    }

    return {
      id: receipt.id,
      receiptNumber: receipt.receiptNumber,
      warehouseId: receipt.warehouseId,
      status: receipt.status,
      receivedAt: receipt.receivedAt,
      lines: receipt.lines.map((line) => ({
        id: line.id,
        productId: line.productId,
        quantity: line.quantity.toFixed(3),
        movementId: line.movementId,
      })),
    };
  }

  private async findReceiptByIdempotencyKey(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<StockReceiptView | null> {
    const receipt = await this.prisma.stockReceipt.findFirst({
      where: { tenantId, idempotencyKey },
      select: { id: true },
    });

    return receipt ? this.getReceipt(tenantId, receipt.id) : null;
  }

  /** Two lines on the same SKU would each read a stale on-hand within one receipt. */
  private assertNoDuplicateProduct(dto: CreateStockReceiptDto): void {
    const seen = new Set<string>();
    for (const line of dto.lines) {
      if (seen.has(line.productId)) {
        throw new BadRequestException(
          'Một sản phẩm chỉ được xuất hiện một lần trong phiếu nhập; hãy gộp số lượng',
        );
      }
      seen.add(line.productId);
    }
  }

  private generateReceiptNumber(): string {
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    return `GRN-${stamp}-${randomUUID().slice(0, 8).toUpperCase()}`;
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === UNIQUE_VIOLATION
    );
  }
}
