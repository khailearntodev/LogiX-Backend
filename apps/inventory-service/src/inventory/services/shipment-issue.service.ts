import { Injectable } from '@nestjs/common';
import { ServiceId } from '@logix/common';
import {
  SHIPMENT_EVENT,
  shipmentLifecycleSchema,
  validateShipmentEnvelope,
  type DomainEventEnvelope,
} from '@logix/messaging';
import { z } from 'zod';
import { PrismaService } from '../../database/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import { StockMovementService } from './stock-movement.service.js';
import { MovementType, ReferenceType } from '../inventory.constants.js';

const CONSUMER = 'inventory-shipment-issue';
@Injectable()
export class ShipmentIssueService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly movements: StockMovementService,
  ) {}
  async handle(event: DomainEventEnvelope): Promise<void> {
    if (event.eventType !== SHIPMENT_EVENT.DISPATCHED) return;
    validateShipmentEnvelope(event, ServiceId.FULFILLMENT_SERVICE, 'Shipment');
    const payload = shipmentLifecycleSchema.parse(event.payload);
    z.string().uuid().parse(event.actorId);
    if (
      !event.actorId ||
      !payload.dispatchRequestId ||
      event.aggregateId !== payload.shipmentId
    )
      throw new Error('Dispatch issue context mismatch');
    const actorId = event.actorId;
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${event.tenantId}:${payload.orderId}`},0))::text`,
      );
      const key = { consumerName: CONSUMER, eventId: event.eventId };
      if (
        await tx.inboxEvent.findUnique({ where: { consumerName_eventId: key } })
      )
        return;
      const group = await tx.reservationGroup.findFirst({
        where: {
          id: payload.reservationGroupId,
          tenantId: event.tenantId,
          orderId: payload.orderId,
          warehouseId: payload.warehouseId,
          deletedAt: null,
        },
        include: {
          reservations: { orderBy: [{ productId: 'asc' }, { id: 'asc' }] },
        },
      });
      if (!group)
        throw new Error('Dispatch references unknown reservation group');
      let outcome = 'ISSUED';
      if (group.status === 'ISSUED') {
        if (
          group.issueShipmentId !== payload.shipmentId ||
          group.issueRequestId !== payload.dispatchRequestId
        )
          throw new Error('Reservation already issued by another dispatch');
        outcome = 'IGNORED_STALE';
      } else {
        if (
          group.status !== 'ACTIVE' ||
          group.reservations.length === 0 ||
          group.reservations.some((line) => line.status !== 'ACTIVE')
        )
          throw new Error('Dispatch cannot issue inactive reservation');
        if (
          await tx.stockMovement.findFirst({
            where: {
              tenantId: event.tenantId,
              referenceType: ReferenceType.SHIPMENT,
              referenceId: payload.shipmentId,
            },
          })
        )
          throw new Error(
            'Shipment issue movements exist without a matching group receipt',
          );
        const quantities = new Map<string, Prisma.Decimal>();
        for (const line of group.reservations) {
          if (
            line.tenantId !== event.tenantId ||
            line.orderId !== payload.orderId ||
            line.warehouseId !== payload.warehouseId
          )
            throw new Error('Reservation line ownership mismatch');
          quantities.set(
            line.productId,
            (quantities.get(line.productId) ?? new Prisma.Decimal(0)).plus(
              line.quantity,
            ),
          );
        }
        const now = new Date(event.occurredAt);
        for (const [productId, quantity] of quantities) {
          await tx.$queryRaw(Prisma.sql`SELECT id FROM inventory.inventory_balances WHERE tenant_id=${event.tenantId}::uuid
            AND warehouse_id=${payload.warehouseId}::uuid AND product_id=${productId}::uuid FOR UPDATE`);
          const balance = await tx.inventoryBalance.findFirstOrThrow({
            where: {
              tenantId: event.tenantId,
              warehouseId: payload.warehouseId,
              productId,
            },
          });
          if (balance.reservedQuantity.lt(quantity))
            throw new Error('Reserved balance is insufficient for dispatch');
          await tx.inventoryBalance.update({
            where: { id: balance.id },
            data: {
              reservedQuantity: { decrement: quantity },
              version: { increment: 1 },
            },
          });
          await this.movements.applyMovementInTransaction(tx, {
            tenantId: event.tenantId,
            warehouseId: payload.warehouseId,
            productId,
            movementType: MovementType.ISSUE,
            quantityDelta: quantity.negated().toFixed(3),
            referenceType: ReferenceType.SHIPMENT,
            referenceId: payload.shipmentId,
            idempotencyKey: `shipment:${payload.shipmentId}:issue:${productId}`,
            actorId,
            correlationId: event.correlationId,
            occurredAt: now,
          });
        }
        await tx.inventoryReservation.updateMany({
          where: {
            tenantId: event.tenantId,
            reservationGroupId: group.id,
            status: 'ACTIVE',
          },
          data: { status: 'ISSUED', issuedAt: now, version: { increment: 1 } },
        });
        await tx.reservationGroup.update({
          where: { id: group.id },
          data: {
            status: 'ISSUED',
            issuedAt: now,
            issueShipmentId: payload.shipmentId,
            issueRequestId: payload.dispatchRequestId,
            version: { increment: 1 },
          },
        });
      }
      await tx.inboxEvent.create({
        data: {
          ...key,
          tenantId: event.tenantId,
          eventType: event.eventType,
          aggregateId: event.aggregateId,
          aggregateVersion: BigInt(event.aggregateVersion),
          outcome,
        },
      });
    });
  }
}
