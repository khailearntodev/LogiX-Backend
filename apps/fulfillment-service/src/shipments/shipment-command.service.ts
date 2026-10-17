import { Injectable } from '@nestjs/common';
import { SHIPMENT_STATUS as S, type ShipmentStatus } from '@logix/messaging';
import { PrismaService } from '../database/prisma.service.js';
import {
  assertShipmentTransition,
  assertShipmentVersion,
  INTENT_STATUS,
  ShipmentErrors,
} from './shipment.domain.js';
import {
  lockShipment,
  recordShipment,
  type ShipmentContext,
} from './shipment.persistence.js';
import { ShipmentQueryService } from './shipment-query.service.js';

@Injectable()
export class ShipmentCommandService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queries: ShipmentQueryService,
  ) {}
  async transition(
    id: string,
    version: number,
    to: ShipmentStatus,
    ctx: ShipmentContext,
    reason: string | null = null,
  ) {
    await this.prisma.$transaction(async (tx) => {
      await lockShipment(tx, ctx.tenantId, id);
      const current = await tx.shipment.findFirst({
        where: { id, tenantId: ctx.tenantId, deletedAt: null },
        include: { dispatchIntent: true },
      });
      if (!current) throw ShipmentErrors.missing();
      assertShipmentVersion(current.version, version);
      if (current.dispatchIntent?.status === INTENT_STATUS.PENDING)
        throw ShipmentErrors.pending();
      const event = assertShipmentTransition(current.status, to);
      const now = new Date();
      const updated = await tx.shipment.update({
        where: { id, tenantId: ctx.tenantId },
        data: {
          status: to,
          version: { increment: 1 },
          ...(to === S.READY_TO_SHIP && { readyAt: now }),
          ...(to === S.DELIVERED && { deliveredAt: now }),
          ...(to === S.FAILED && { failedAt: now, failureReason: reason }),
        },
      });
      await recordShipment(tx, updated, current.status, event, ctx, reason);
    });
    return this.queries.detail(ctx.tenantId, id);
  }
}
