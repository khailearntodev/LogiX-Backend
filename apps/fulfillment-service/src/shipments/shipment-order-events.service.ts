import { Injectable } from '@nestjs/common';
import { ServiceId } from '@logix/common';
import {
  confirmedShipmentSchema,
  shipmentLineSchema,
  SHIPMENT_EVENT as E,
  SHIPMENT_STATUS as S,
  validateShipmentEnvelope,
  type DomainEventEnvelope,
} from '@logix/messaging';
import { z } from 'zod';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { OrderClient } from './order.client.js';
import { INTENT_STATUS, SHIPMENT_CONSUMER } from './shipment.domain.js';
import { lockShipment, recordShipment } from './shipment.persistence.js';

const legacyLine = shipmentLineSchema.pick({
  orderLineId: true,
  lineNumber: true,
  productId: true,
  quantity: true,
});
const legacyConfirmed = confirmedShipmentSchema.extend({
  orderLines: z.array(legacyLine).nonempty(),
});
@Injectable()
export class ShipmentOrderEventsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrderClient,
  ) {}
  async handle(event: DomainEventEnvelope): Promise<void> {
    if (
      event.eventType !== 'OrderConfirmed' &&
      event.eventType !== 'OrderCanceled'
    )
      return;
    validateShipmentEnvelope(event, ServiceId.ORDER_SERVICE, 'SalesOrder');
    const base = z.object({ orderId: z.string().uuid() }).parse(event.payload);
    if (base.orderId !== event.aggregateId)
      throw new Error('Order aggregate mismatch');
    const ctx = {
      tenantId: event.tenantId,
      actorId: event.actorId,
      correlationId: event.correlationId,
      causationId: event.eventId,
    };
    if (
      await this.prisma.inboxEvent.findUnique({
        where: {
          consumerName_eventId: {
            consumerName: SHIPMENT_CONSUMER,
            eventId: event.eventId,
          },
        },
      })
    )
      return;
    const knownCursor = await this.prisma.shipmentOrderCursor.findUnique({
      where: {
        tenantId_orderId: {
          tenantId: event.tenantId,
          orderId: base.orderId,
        },
      },
    });
    const knownStale =
      knownCursor &&
      (knownCursor.canceled ||
        knownCursor.orderVersion >= BigInt(event.aggregateVersion));
    let confirmed: z.infer<typeof confirmedShipmentSchema> | undefined;
    const cancellationReason =
      event.eventType === 'OrderCanceled'
        ? z
            .object({
              reason: z.string().min(1),
              canceledAt: z.string().datetime(),
            })
            .parse(event.payload).reason
        : null;
    // Cursors only advance. An already-final source must not depend on Order availability for legacy replay.
    if (event.eventType === 'OrderConfirmed' && !knownStale) {
      const legacy = legacyConfirmed.parse(event.payload);
      if (legacy.orderVersion !== event.aggregateVersion)
        throw new Error('Confirmation version mismatch');
      const rich = confirmedShipmentSchema.safeParse(event.payload);
      if (rich.success) confirmed = rich.data;
      else {
        const sourceLines = z
          .array(z.record(z.unknown()))
          .parse(
            z.object({ orderLines: z.unknown() }).parse(event.payload)
              .orderLines,
          );
        if (
          sourceLines.some((line) =>
            [
              'skuSnapshot',
              'productNameSnapshot',
              'unitSnapshot',
              'unitWeight',
              'unitVolume',
            ].some((key) => key in line),
          )
        )
          throw rich.error;
        const snapshot = await this.orders.snapshot(base.orderId, ctx);
        if (
          snapshot.id !== base.orderId ||
          snapshot.reservationGroupId !== legacy.reservationGroupId
        )
          throw new Error('Legacy snapshot reservation mismatch');
        const lines = legacy.orderLines.map((line) => {
          const saved = snapshot.lines.find(
            (saved) => saved.id === line.orderLineId,
          );
          if (
            !saved ||
            saved.productId !== line.productId ||
            saved.lineNumber !== line.lineNumber ||
            !new Prisma.Decimal(saved.quantity).equals(line.quantity)
          )
            throw new Error('Legacy snapshot line mismatch');
          return { ...saved, ...line };
        });
        if (lines.length !== snapshot.lines.length)
          throw new Error('Legacy snapshot line count mismatch');
        confirmed = confirmedShipmentSchema.parse({
          ...legacy,
          orderLines: lines,
        });
      }
      if (
        confirmed.customerSnapshot.customerId !== confirmed.customerId ||
        confirmed.deliveryAddressSnapshot.addressId !==
          confirmed.deliveryAddressId ||
        confirmed.warehouseSnapshot.warehouseId !== confirmed.warehouseId ||
        new Set(confirmed.orderLines.map((l) => l.orderLineId)).size !==
          confirmed.orderLines.length
      )
        throw new Error('Shipment source snapshots mismatch');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${event.tenantId}:${base.orderId}`},0))::text`,
      );
      const inboxKey = {
        consumerName: SHIPMENT_CONSUMER,
        eventId: event.eventId,
      };
      if (
        await tx.inboxEvent.findUnique({
          where: { consumerName_eventId: inboxKey },
        })
      )
        return;
      const cursorKey = { tenantId: event.tenantId, orderId: base.orderId };
      const cursor = await tx.shipmentOrderCursor.findUnique({
        where: { tenantId_orderId: cursorKey },
      });
      let outcome = 'APPLIED';
      if (
        cursor &&
        (cursor.orderVersion >= BigInt(event.aggregateVersion) ||
          cursor.canceled)
      )
        outcome = 'IGNORED_STALE';
      else {
        const existing = await tx.shipment.findUnique({
          where: { tenantId_orderId: cursorKey },
        });
        if (confirmed) {
          if (existing) {
            if (existing.reservationGroupId !== confirmed.reservationGroupId)
              throw new Error(
                'One order cannot have another shipment reservation',
              );
            outcome = 'IGNORED_STALE';
          } else {
            const shipment = await tx.shipment.create({
              data: {
                tenantId: event.tenantId,
                shipmentNumber: `SHP-${base.orderId}`,
                orderId: base.orderId,
                orderNumber: confirmed.orderNumber,
                confirmedOrderVersion: BigInt(confirmed.orderVersion),
                warehouseId: confirmed.warehouseId,
                deliveryAddressId: confirmed.deliveryAddressId,
                customerSnapshot:
                  confirmed.customerSnapshot as Prisma.InputJsonObject,
                deliveryAddressSnapshot:
                  confirmed.deliveryAddressSnapshot as Prisma.InputJsonObject,
                warehouseSnapshot:
                  confirmed.warehouseSnapshot as Prisma.InputJsonObject,
                reservationGroupId: confirmed.reservationGroupId,
                status: S.PENDING_PICK,
                totalWeight: confirmed.totalWeight,
                totalVolume: confirmed.totalVolume,
                items: {
                  create: confirmed.orderLines.map((line) => ({
                    tenantId: event.tenantId,
                    orderLineId: line.orderLineId,
                    productId: line.productId,
                    skuSnapshot: line.skuSnapshot,
                    productNameSnapshot: line.productNameSnapshot,
                    unitSnapshot: line.unitSnapshot,
                    quantity: line.quantity,
                    weight: new Prisma.Decimal(line.unitWeight).mul(
                      line.quantity,
                    ),
                    volume: new Prisma.Decimal(line.unitVolume).mul(
                      line.quantity,
                    ),
                  })),
                },
              },
            });
            await recordShipment(tx, shipment, null, E.CREATED, ctx);
          }
        } else if (existing) {
          await lockShipment(tx, event.tenantId, existing.id);
          const current = await tx.shipment.findUniqueOrThrow({
            where: { id: existing.id },
          });
          if (
            [S.DISPATCHED, S.DELIVERED, S.FAILED].some(
              (status) => status === current.status,
            )
          ) {
            const rejected = await tx.shipment.update({
              where: { id: current.id },
              data: { version: { increment: 1 } },
            });
            await recordShipment(
              tx,
              rejected,
              current.status,
              E.CANCEL_REJECTED,
              ctx,
              'ORDER_DISPATCH_COMMITTED',
            );
            outcome = 'CANCEL_REJECTED';
          } else if (current.status !== S.CANCELED) {
            await tx.shipmentDispatchIntent.updateMany({
              where: {
                tenantId: event.tenantId,
                shipmentId: current.id,
                status: INTENT_STATUS.PENDING,
              },
              data: {
                status: INTENT_STATUS.REJECTED,
                rejectionReason: 'ORDER_CANCELED',
              },
            });
            const canceled = await tx.shipment.update({
              where: { id: current.id },
              data: { status: S.CANCELED, version: { increment: 1 } },
            });
            await recordShipment(
              tx,
              canceled,
              current.status,
              E.CANCELED,
              ctx,
              cancellationReason,
            );
          }
        }
        await tx.shipmentOrderCursor.upsert({
          where: { tenantId_orderId: cursorKey },
          create: {
            ...cursorKey,
            orderVersion: BigInt(event.aggregateVersion),
            canceled: !confirmed,
          },
          update: {
            orderVersion: BigInt(event.aggregateVersion),
            canceled: !confirmed,
          },
        });
      }
      await tx.inboxEvent.create({
        data: {
          ...inboxKey,
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
