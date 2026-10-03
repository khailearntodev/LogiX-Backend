import { Injectable, NotImplementedException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import type { MovementType, ReferenceType } from '../inventory.constants.js';
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

/**
 * The only write primitive for on-hand quantity: locks the balance row, writes
 * one StockMovement and one OutboxEvent in the same transaction, and replays
 * safely on a duplicate idempotencyKey.
 */
@Injectable()
export class StockMovementService {
  constructor(private readonly prisma: PrismaService) {}

  async applyMovement(_command: ApplyMovementCommand): Promise<StockMovementView> {
    throw new NotImplementedException('applyMovement chưa được triển khai');
  }

  /** Same contract as applyMovement but joins a caller-owned transaction. */
  async applyMovementInTransaction(
    _tx: unknown,
    _command: ApplyMovementCommand,
  ): Promise<StockMovementView> {
    throw new NotImplementedException(
      'applyMovementInTransaction chưa được triển khai',
    );
  }
}
