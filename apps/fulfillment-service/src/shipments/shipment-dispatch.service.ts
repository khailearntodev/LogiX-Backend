import { Injectable } from '@nestjs/common';
import { SHIPMENT_STATUS as S, SHIPMENT_EVENT as E } from '@logix/messaging';
import { PrismaService } from '../database/prisma.service.js';
import { OrderClient, OrderRequestRejected } from './order.client.js';
import {
  assertShipmentTransition,
  assertShipmentVersion,
  INTENT_STATUS as I,
  ShipmentErrors,
} from './shipment.domain.js';
import {
  lockShipment,
  recordShipment,
  type ShipmentContext,
} from './shipment.persistence.js';
import { ShipmentQueryService } from './shipment-query.service.js';
import type { DispatchShipmentDto } from './shipment.dto.js';
import { Prisma } from '../generated/prisma/client.js';

@Injectable()
export class ShipmentDispatchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrderClient,
    private readonly queries: ShipmentQueryService,
  ) {}
  async preview(id: string, ctx: ShipmentContext) {
    const shipment = await this.prisma.shipment.findFirst({
      where: { tenantId: ctx.tenantId, id, deletedAt: null },
      include: { dispatchIntent: true },
    });
    if (!shipment) throw ShipmentErrors.missing();
    if (shipment.dispatchIntent?.status === I.PENDING)
      throw ShipmentErrors.pending();
    assertShipmentTransition(shipment.status, S.DISPATCHED);
    const order = await this.orders.snapshot(shipment.orderId, ctx);
    if (
      order.status !== S.READY_TO_SHIP ||
      order.cancellationRequestedAt ||
      order.reservationGroupId !== shipment.reservationGroupId
    )
      throw ShipmentErrors.transition();
    return {
      shipmentId: id,
      shipmentNumber: shipment.shipmentNumber,
      orderId: shipment.orderId,
      version: Number(shipment.version),
      orderVersion: order.version,
      reservationGroupId: shipment.reservationGroupId,
    };
  }
  async dispatch(id: string, dto: DispatchShipmentDto, ctx: ShipmentContext) {
    if (!ctx.actorId) throw new Error('Dispatch requires authenticated actor');
    const actorId = ctx.actorId;
    const before = await this.prisma.shipment.findFirst({
      where: { tenantId: ctx.tenantId, id, deletedAt: null },
      include: { dispatchIntent: true },
    });
    if (!before) throw ShipmentErrors.missing();
    if (before.dispatchIntent?.id !== dto.requestId) {
      if (before.dispatchIntent && before.dispatchIntent.status !== I.REJECTED)
        throw ShipmentErrors.pending();
      assertShipmentVersion(before.version, dto.version);
      assertShipmentTransition(before.status, S.DISPATCHED);
      const order = await this.orders.snapshot(before.orderId, ctx);
      if (
        order.id !== before.orderId ||
        order.status !== S.READY_TO_SHIP ||
        order.cancellationRequestedAt ||
        order.reservationGroupId !== before.reservationGroupId
      )
        throw ShipmentErrors.transition();
      if (order.version !== dto.orderVersion) throw ShipmentErrors.version();
    }
    try {
      await this.prisma.$transaction(async (tx) => {
        await lockShipment(tx, ctx.tenantId, id);
        const shipment = await tx.shipment.findFirst({
          where: { tenantId: ctx.tenantId, id, deletedAt: null },
          include: { dispatchIntent: true },
        });
        if (!shipment) throw ShipmentErrors.missing();
        const intent = shipment.dispatchIntent;
        if (intent?.id === dto.requestId) {
          if (
            intent.orderVersion !== BigInt(dto.orderVersion) ||
            intent.shipmentVersion !== BigInt(dto.version) ||
            intent.actorId !== ctx.actorId
          )
            throw ShipmentErrors.version();
          if (intent.status === I.REJECTED) throw ShipmentErrors.transition();
          return;
        }
        if (intent && intent.status !== I.REJECTED)
          throw ShipmentErrors.pending();
        assertShipmentVersion(shipment.version, dto.version);
        assertShipmentTransition(shipment.status, S.DISPATCHED);
        if (intent)
          await tx.shipmentDispatchIntent.delete({ where: { id: intent.id } });
        await tx.shipmentDispatchIntent.create({
          data: {
            id: dto.requestId,
            tenantId: ctx.tenantId,
            shipmentId: id,
            orderVersion: BigInt(dto.orderVersion),
            shipmentVersion: shipment.version,
            actorId,
            correlationId: ctx.correlationId,
            status: I.PENDING,
          },
        });
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      )
        throw ShipmentErrors.version();
      throw error;
    }
    await this.complete(ctx.tenantId, id);
    return this.queries.detail(ctx.tenantId, id);
  }
  async complete(tenantId: string, id: string): Promise<void> {
    const shipment = await this.prisma.shipment.findFirst({
      where: { tenantId, id },
      include: { dispatchIntent: true },
    });
    const intent = shipment?.dispatchIntent;
    if (!shipment || !intent || intent.status !== I.PENDING) return;
    const ctx = {
      tenantId,
      actorId: intent.actorId,
      correlationId: intent.correlationId,
    };
    let grant;
    try {
      grant = await this.orders.authorize(
        shipment.orderId,
        {
          requestId: intent.id,
          shipmentId: id,
          reservationGroupId: shipment.reservationGroupId,
          orderVersion: Number(intent.orderVersion),
          actorId: intent.actorId,
        },
        ctx,
      );
    } catch (error) {
      // Only a definitive business rejection can release the local intent. Unknown outcomes retry the identical request.
      if (error instanceof OrderRequestRejected && error.status === 409) {
        await this.prisma.shipmentDispatchIntent.updateMany({
          where: { id: intent.id, status: I.PENDING },
          data: { status: I.REJECTED, rejectionReason: 'ORDER_CONFLICT' },
        });
        throw ShipmentErrors.upstream(error.status);
      }
      throw error;
    }
    if (
      grant.requestId !== intent.id ||
      grant.shipmentId !== id ||
      grant.orderId !== shipment.orderId ||
      grant.reservationGroupId !== shipment.reservationGroupId ||
      grant.orderVersion !== Number(intent.orderVersion) ||
      grant.actorId !== intent.actorId ||
      grant.correlationId !== intent.correlationId
    )
      throw new Error('Order returned a mismatched dispatch grant');
    await this.prisma.$transaction(async (tx) => {
      await lockShipment(tx, tenantId, id);
      const current = await tx.shipment.findFirstOrThrow({
        where: { tenantId, id },
        include: { dispatchIntent: true },
      });
      if (current.dispatchIntent?.id !== intent.id)
        throw new Error('Dispatch intent changed after grant');
      if (current.dispatchIntent.status === I.COMPLETED) return;
      assertShipmentTransition(current.status, S.DISPATCHED);
      const dispatched = await tx.shipment.update({
        where: { id, tenantId },
        data: {
          status: S.DISPATCHED,
          dispatchIssuedAt: new Date(grant.grantedAt),
          version: { increment: 1 },
        },
      });
      await tx.shipmentDispatchIntent.update({
        where: { id: intent.id },
        data: { status: I.COMPLETED },
      });
      await recordShipment(
        tx,
        dispatched,
        current.status,
        E.DISPATCHED,
        ctx,
        null,
        intent.id,
      );
    });
  }
}
