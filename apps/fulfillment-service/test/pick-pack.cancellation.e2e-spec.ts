import { randomUUID } from 'node:crypto';
import { ServiceId } from '@logix/common';
import {
  INTERNAL_SERVICE_TOKEN_HEADER,
  signInternalServiceToken,
} from '@logix/auth';
import {
  confirmedShipmentSchema,
  SHIPMENT_PERMISSIONS as P,
  SHIPMENT_STATUS as S,
} from '@logix/messaging';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, PickPackStack } from './pick-pack.stack.js';

describe.runIf(process.env.PICK_PACK_STACK_E2E === '1')(
  'Cancellation, reservation and event replay on an isolated stack',
  () => {
    const stack = new PickPackStack();
    beforeAll(() => stack.start(), 240_000);
    afterAll(() => stack.close(), 90_000);
    const readOrder = (id: string) =>
      stack.orders.salesOrder.findUniqueOrThrow({ where: { id } });
    const readShipment = (id: string) =>
      stack.fulfillment.shipment.findUniqueOrThrow({ where: { id } });
    const picking = (id: string, action: string, version: number) =>
      stack
        .http()
        .post(`/api/v1/shipments/${id}/${action}`)
        .set('Authorization', `Bearer ${stack.token([P.UPDATE])}`)
        .send({ version });
    const cancel = async (id: string) => {
      const order = await readOrder(id);
      return stack
        .http()
        .post(`/api/v1/orders/${id}/cancel`)
        .set(
          'Authorization',
          `Bearer ${stack.token(['order:sales-order:cancel'])}`,
        )
        .send({ version: Number(order.version), reason: 'QA cancellation' });
    };
    const balance = (productId: string) =>
      stack.inventory.inventoryBalance.findFirstOrThrow({
        where: { tenantId: stack.tenantId, productId },
      });
    async function advance(
      f: Awaited<ReturnType<PickPackStack['seed']>>,
      status: string,
    ) {
      if (status !== S.PENDING_PICK) {
        await picking(f.shipmentId, 'start-picking', 1).expect(200);
        await eventually(
          'Order picking',
          () => readOrder(f.orderId),
          (order) => order.status === S.PICKING,
        );
      }
      if (status === S.READY_TO_SHIP) {
        await picking(f.shipmentId, 'mark-ready', 2).expect(200);
        await eventually(
          'Order ready',
          () => readOrder(f.orderId),
          (order) => order.status === S.READY_TO_SHIP,
        );
      }
    }
    const internalHeader = (audience: string, service: string) =>
      signInternalServiceToken({
        secret: stack.internalSecret,
        service,
        audience,
        tenantId: stack.tenantId,
        ttlSeconds: 60,
      });
    const authorize = async (f: Awaited<ReturnType<PickPackStack['seed']>>) => {
      const order = await readOrder(f.orderId);
      return request(stack.url('order-service'))
        .post(`/internal/orders/${f.orderId}/authorize-dispatch`)
        .set(
          INTERNAL_SERVICE_TOKEN_HEADER,
          internalHeader(
            ServiceId.ORDER_SERVICE,
            ServiceId.FULFILLMENT_SERVICE,
          ),
        )
        .send({
          requestId: randomUUID(),
          shipmentId: f.shipmentId,
          reservationGroupId: order.reservationGroupId,
          orderVersion: Number(order.version),
          actorId: stack.actorId,
        });
    };
    async function replayOrder(
      orderId: string,
      eventType: string,
      newId: boolean,
    ) {
      const row = await stack.orders.outboxEvent.findFirstOrThrow({
        where: { aggregateId: orderId, eventType },
        orderBy: { aggregateVersion: 'asc' },
      });
      const envelope = {
        eventId: newId ? randomUUID() : row.id,
        eventType: row.eventType,
        eventVersion: row.eventVersion,
        tenantId: row.tenantId,
        producer: ServiceId.ORDER_SERVICE,
        aggregateType: row.aggregateType,
        aggregateId: row.aggregateId,
        aggregateVersion: Number(row.aggregateVersion),
        actorId: stack.actorId,
        correlationId: row.correlationId,
        causationId: row.causationId ?? row.correlationId,
        occurredAt: row.occurredAt.toISOString(),
        payload: row.payload,
      };
      await stack.publish(0, envelope);
      if (newId)
        await eventually(
          'Fulfillment consumed replay',
          () =>
            stack.fulfillment.inboxEvent.findFirst({
              where: { eventId: envelope.eventId },
            }),
          Boolean,
        );
      return envelope;
    }

    it.each([S.PENDING_PICK, S.PICKING, S.READY_TO_SHIP])(
      'cancels from %s and releases once without reducing on-hand',
      async (status) => {
        const f = await stack.seed();
        await advance(f, status);
        const before = await balance(f.productId);
        expect((await cancel(f.orderId)).status).toBe(200);
        await eventually(
          'Shipment canceled',
          () => readShipment(f.shipmentId),
          (row) => row.status === S.CANCELED,
        );
        const after = await balance(f.productId);
        expect(after.onHandQuantity).toEqual(before.onHandQuantity);
        expect(after.reservedQuantity.toFixed()).toBe('0');
        expect(after.version).toBe(before.version + 1n);
        const group = await stack.inventory.reservationGroup.findFirstOrThrow({
          where: { orderId: f.orderId },
        });
        expect(group.status).toBe('RELEASED');
        const reservations =
          await stack.inventory.inventoryReservation.findMany({
            where: { orderId: f.orderId },
          });
        expect(reservations.every((row) => row.status === 'RELEASED')).toBe(
          true,
        );
        expect(
          await stack.inventory.stockMovement.count({
            where: { productId: f.productId },
          }),
        ).toBe(0);
        // Exact HTTP retry and new event IDs must not release quantities again.
        await request(stack.url('inventory-service'))
          .post('/internal/reservations/release')
          .set(
            INTERNAL_SERVICE_TOKEN_HEADER,
            internalHeader(
              ServiceId.INVENTORY_SERVICE,
              ServiceId.ORDER_SERVICE,
            ),
          )
          .set('x-correlation-id', randomUUID())
          .send({ orderId: f.orderId })
          .expect(201);
        const replay = await replayOrder(f.orderId, 'OrderCanceled', true);
        await eventually(
          'Inventory consumed cancellation replay',
          () =>
            stack.inventory.inboxEvent.findFirst({
              where: { eventId: replay.eventId },
            }),
          Boolean,
        );
        expect(await balance(f.productId)).toEqual(after);
        expect(
          await stack.inventory.outboxEvent.count({
            where: { aggregateId: group.id, eventType: 'StockReleased' },
          }),
        ).toBe(1);
        for (const action of ['start-picking', 'mark-ready']) {
          const current = await readShipment(f.shipmentId);
          const response = await picking(
            f.shipmentId,
            action,
            Number(current.version),
          ).expect(409);
          expect(response.body.details.reason).toBe(
            'SHIPMENT_INVALID_TRANSITION',
          );
        }
      },
      60_000,
    );

    it('deduplicates confirmed events and ignores stale confirmation after cancellation', async () => {
      const f = await stack.seed();
      await replayOrder(f.orderId, 'OrderConfirmed', false);
      await replayOrder(f.orderId, 'OrderConfirmed', true);
      expect(
        await stack.fulfillment.shipment.count({
          where: { orderId: f.orderId },
        }),
      ).toBe(1);
      expect((await readShipment(f.shipmentId)).version).toBe(1n);
      expect((await cancel(f.orderId)).status).toBe(200);
      await eventually(
        'Shipment canceled',
        () => readShipment(f.shipmentId),
        (row) => row.status === S.CANCELED,
      );
      const canceled = await readShipment(f.shipmentId);
      await replayOrder(f.orderId, 'OrderConfirmed', true);
      expect(await readShipment(f.shipmentId)).toEqual(canceled);
    }, 60_000);

    it('keeps a cancellation tombstone when an unseen order later replays a legacy confirmation', async () => {
      const f = await stack.seed();
      const source = await replayOrder(f.orderId, 'OrderConfirmed', true);
      const rich = confirmedShipmentSchema.parse(source.payload);
      const orderId = randomUUID();
      const group = await stack.inventory.reservationGroup.create({
        data: {
          tenantId: stack.tenantId,
          orderId,
          warehouseId: rich.warehouseId,
          status: 'RELEASED',
          idempotencyKey: `qa:${orderId}`,
          orderVersion: 2n,
        },
      });
      const canceled = {
        ...source,
        eventId: randomUUID(),
        aggregateId: orderId,
        aggregateVersion: 4,
        eventType: 'OrderCanceled',
        payload: {
          orderId,
          canceledAt: new Date().toISOString(),
          reason: 'QA early cancel',
        },
      };
      await stack.publish(0, canceled);
      await eventually(
        'Cancellation tombstone consumed',
        () =>
          stack.fulfillment.inboxEvent.findFirst({
            where: { eventId: canceled.eventId },
          }),
        Boolean,
      );
      const legacy = {
        ...source,
        eventId: randomUUID(),
        aggregateId: orderId,
        aggregateVersion: 2,
        payload: {
          ...rich,
          orderId,
          orderVersion: 2,
          reservationGroupId: group.id,
          orderLines: rich.orderLines.map(
            ({ orderLineId, lineNumber, productId, quantity }) => ({
              orderLineId,
              lineNumber,
              productId,
              quantity,
            }),
          ),
        },
      };
      await stack.publish(0, legacy);
      const inbox = await eventually(
        'Late legacy confirmation consumed without Order snapshot HTTP',
        () =>
          stack.fulfillment.inboxEvent.findFirst({
            where: { eventId: legacy.eventId },
          }),
        Boolean,
      );
      expect(inbox?.outcome).toBe('IGNORED_STALE');
      expect(
        await stack.orders.salesOrder.findUnique({ where: { id: orderId } }),
      ).toBeNull();
      expect(
        await stack.fulfillment.shipment.count({ where: { orderId } }),
      ).toBe(0);
      expect(
        await stack.fulfillment.shipmentOrderCursor.findUniqueOrThrow({
          where: { tenantId_orderId: { tenantId: stack.tenantId, orderId } },
        }),
      ).toMatchObject({ canceled: true, orderVersion: 4n });
    }, 60_000);

    it('does not move Order backward or append history on exact/new-ID lifecycle replay', async () => {
      const f = await stack.seed();
      await advance(f, S.READY_TO_SHIP);
      const before = await readOrder(f.orderId);
      const histories = await stack.orders.orderStatusHistory.count({
        where: { orderId: f.orderId },
      });
      const row = await stack.fulfillment.outboxEvent.findFirstOrThrow({
        where: { aggregateId: f.shipmentId, eventType: 'ShipmentPicking' },
      });
      const event = {
        eventId: row.id,
        eventType: row.eventType,
        eventVersion: row.eventVersion,
        tenantId: row.tenantId,
        producer: ServiceId.FULFILLMENT_SERVICE,
        aggregateType: row.aggregateType,
        aggregateId: row.aggregateId,
        aggregateVersion: Number(row.aggregateVersion),
        actorId: stack.actorId,
        correlationId: row.correlationId,
        causationId: row.causationId ?? row.correlationId,
        occurredAt: row.occurredAt.toISOString(),
        payload: row.payload,
      };
      await stack.publish(2, event);
      const replay = { ...event, eventId: randomUUID() };
      await stack.publish(2, replay);
      const inbox = await eventually(
        'Order consumes replay',
        () =>
          stack.orders.inboxEvent.findFirst({
            where: { eventId: replay.eventId },
          }),
        Boolean,
      );
      expect(inbox?.outcome).toBe('IGNORED_STALE');
      expect(await readOrder(f.orderId)).toEqual(before);
      expect(
        await stack.orders.orderStatusHistory.count({
          where: { orderId: f.orderId },
        }),
      ).toBe(histories);
    }, 60_000);

    it('persists failed cancellation intent, blocks dispatch, and recovers after private Inventory restart', async () => {
      const f = await stack.seed();
      await advance(f, S.READY_TO_SHIP);
      await stack.stopService('inventory-service');
      try {
        expect((await cancel(f.orderId)).status).toBe(503);
        const pending = await readOrder(f.orderId);
        expect(pending.status).toBe(S.READY_TO_SHIP);
        expect(pending.cancellationRequestedAt).not.toBeNull();
        expect(
          await stack.orders.outboxEvent.count({
            where: { aggregateId: f.orderId, eventType: 'OrderCanceled' },
          }),
        ).toBe(0);
        expect((await authorize(f)).status).toBe(409);
        expect((await balance(f.productId)).reservedQuantity.toFixed()).toBe(
          '1.125',
        );
      } finally {
        await stack.startService('inventory-service');
      }
      await eventually(
        'Order recovery finalizes cancellation',
        () => readOrder(f.orderId),
        (row) => row.status === S.CANCELED,
      );
      await eventually(
        'Recovered cancellation reaches Shipment',
        () => readShipment(f.shipmentId),
        (row) => row.status === S.CANCELED,
      );
      expect((await balance(f.productId)).reservedQuantity.toFixed()).toBe('0');
    }, 60_000);

    it.each(['start-picking', 'mark-ready'])(
      'converges canceled when cancellation races %s',
      async (action) => {
        const f = await stack.seed();
        if (action === 'mark-ready') await advance(f, S.PICKING);
        const shipment = await readShipment(f.shipmentId);
        const [cancelResponse, pickResponse] = await Promise.all([
          cancel(f.orderId),
          picking(f.shipmentId, action, Number(shipment.version)),
        ]);
        // A projection winning the Order lock may stale the cancellation version.
        if (cancelResponse.status === 409)
          expect((await cancel(f.orderId)).status).toBe(200);
        else expect(cancelResponse.status).toBe(200);
        expect([200, 409]).toContain(pickResponse.status);
        await eventually(
          'Raced shipment canceled',
          () => readShipment(f.shipmentId),
          (row) => row.status === S.CANCELED,
        );
        const after = await balance(f.productId);
        expect(after.reservedQuantity.toFixed()).toBe('0');
        expect(after.onHandQuantity.toFixed()).toBe('10.5');
        expect(
          await stack.inventory.outboxEvent.count({
            where: {
              eventType: 'StockReleased',
              payload: { path: ['orderId'], equals: f.orderId },
            },
          }),
        ).toBe(1);
      },
      60_000,
    );

    it('rejects cancellation after an irrevocable grant even before IN_DELIVERY projection', async () => {
      const f = await stack.seed();
      await advance(f, S.READY_TO_SHIP);
      const before = await balance(f.productId);
      expect((await authorize(f)).status).toBe(201);
      const granted = await readOrder(f.orderId);
      expect(granted.status).toBe(S.READY_TO_SHIP);
      expect(granted.dispatchGrantedAt).not.toBeNull();
      expect((await cancel(f.orderId)).status).toBe(409);
      expect(await balance(f.productId)).toEqual(before);
      expect(
        await stack.orders.outboxEvent.count({
          where: { aggregateId: f.orderId, eventType: 'OrderCanceled' },
        }),
      ).toBe(0);
    }, 60_000);

    it('fails visibly for inconsistent reserved balance, then completes only after isolated fixture repair', async () => {
      const f = await stack.seed();
      const before = await balance(f.productId);
      await stack.inventory.inventoryBalance.update({
        where: { id: before.id },
        data: { reservedQuantity: '0' },
      });
      expect((await cancel(f.orderId)).status).toBe(502);
      expect(
        (await readOrder(f.orderId)).cancellationRequestedAt,
      ).not.toBeNull();
      expect(
        await stack.orders.outboxEvent.count({
          where: { aggregateId: f.orderId, eventType: 'OrderCanceled' },
        }),
      ).toBe(0);
      expect(
        (
          await stack.inventory.reservationGroup.findFirstOrThrow({
            where: { orderId: f.orderId },
          })
        ).status,
      ).toBe('ACTIVE');
      // Restore only the deliberate inconsistency in this disposable fixture.
      await stack.inventory.inventoryBalance.update({
        where: { id: before.id },
        data: { reservedQuantity: before.reservedQuantity },
      });
      await eventually(
        'Repaired fixture cancellation recovers',
        () => readOrder(f.orderId),
        (row) => row.status === S.CANCELED,
      );
    }, 60_000);
  },
);
