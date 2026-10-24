import { randomUUID } from 'node:crypto';
import {
  SHIPMENT_PERMISSIONS as P,
  SHIPMENT_STATUS as S,
} from '@logix/messaging';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, PickPackStack } from './pick-pack.stack.js';

describe.runIf(process.env.PICK_PACK_STACK_E2E === '1')(
  'Pick/pack real HTTP, PostgreSQL transactions and Kafka',
  () => {
    const stack = new PickPackStack();
    beforeAll(() => stack.start(), 240_000);
    afterAll(() => stack.close(), 90_000);

    const post = (
      id: string,
      action: string,
      body: object,
      permissions: string[] = [P.UPDATE],
      tenant?: string,
    ) =>
      stack
        .http()
        .post(`/api/v1/shipments/${id}/${action}`)
        .set('Authorization', `Bearer ${stack.token(permissions, tenant)}`)
        .send(body);
    const current = (id: string) =>
      stack.fulfillment.shipment.findUniqueOrThrow({ where: { id } });
    const counts = async (id: string) => ({
      history: await stack.fulfillment.shipmentStatusHistory.count({
        where: { shipmentId: id },
      }),
      events: await stack.fulfillment.outboxEvent.count({
        where: { aggregateId: id },
      }),
    });
    const stock = async (orderId: string) => ({
      groups: await stack.inventory.reservationGroup.findMany({
        where: { orderId },
      }),
      reservations: await stack.inventory.inventoryReservation.findMany({
        where: { orderId },
      }),
      movements: await stack.inventory.stockMovement.findMany({
        where: { referenceId: orderId },
      }),
    });

    it('confirms once, snapshots exact quantities, then projects pick/ready via real Kafka without changing stock', async () => {
      const f = await stack.seed();
      const initial = await current(f.shipmentId);
      const items = await stack.fulfillment.shipmentItem.findMany({
        where: { shipmentId: f.shipmentId },
      });
      expect(items).toHaveLength(1);
      expect(items[0].quantity.toFixed()).toBe('1.125');
      expect(items[0]).toMatchObject({
        skuSnapshot: 'QA-SKU',
        unitSnapshot: 'PCS',
      });
      const beforeStock = await stock(f.orderId);
      const beforeBalance =
        await stack.inventory.inventoryBalance.findFirstOrThrow({
          where: { tenantId: stack.tenantId, productId: f.productId },
        });
      expect(beforeBalance.onHandQuantity.toFixed()).toBe('10.5');
      expect(beforeBalance.reservedQuantity.toFixed()).toBe('1.125');
      const picking = await post(f.shipmentId, 'start-picking', {
        version: 1,
      }).expect(200);
      expect(picking.body).toMatchObject({
        status: S.PICKING,
        version: 2,
        readyAt: null,
      });
      await eventually(
        'Order PICKING projection',
        () =>
          stack.orders.salesOrder.findUniqueOrThrow({
            where: { id: f.orderId },
          }),
        (order) => order.status === S.PICKING,
      );
      const ready = await post(f.shipmentId, 'mark-ready', {
        version: 2,
      }).expect(200);
      expect(ready.body).toMatchObject({ status: S.READY_TO_SHIP, version: 3 });
      expect(ready.body.readyAt).toEqual(expect.any(String));
      await eventually(
        'Order READY projection',
        () =>
          stack.orders.salesOrder.findUniqueOrThrow({
            where: { id: f.orderId },
          }),
        (order) => order.status === S.READY_TO_SHIP,
      );
      const after = await current(f.shipmentId);
      expect(after.readyAt).not.toBeNull();
      expect(after.customerSnapshot).toEqual(initial.customerSnapshot);
      expect(after.warehouseSnapshot).toEqual(initial.warehouseSnapshot);
      expect(after.deliveryAddressSnapshot).toEqual(
        initial.deliveryAddressSnapshot,
      );
      expect(
        await stack.fulfillment.shipmentItem.findMany({
          where: { shipmentId: f.shipmentId },
        }),
      ).toEqual(items);
      expect(await stock(f.orderId)).toEqual(beforeStock);
      expect(
        await stack.inventory.inventoryBalance.findUniqueOrThrow({
          where: { id: beforeBalance.id },
        }),
      ).toEqual(beforeBalance);
      expect(await counts(f.shipmentId)).toEqual({ history: 3, events: 3 });
      await post(f.shipmentId, 'mark-ready', { version: 2 }).expect(409);
      expect((await current(f.shipmentId)).readyAt).toEqual(after.readyAt);
      expect(await counts(f.shipmentId)).toEqual({ history: 3, events: 3 });
    }, 60_000);

    it('preserves the long-SKU decimal Pick List in authoritative GETs after both version-only commands', async () => {
      const sku = `QA-PICK-LIST-${'LONG-SKU-'.repeat(12)}`.slice(0, 100);
      expect(sku).toHaveLength(100);
      const f = await stack.seed(sku, true);
      const get = () =>
        stack
          .http()
          .get(`/api/v1/shipments/${f.shipmentId}`)
          .set('Authorization', `Bearer ${stack.token([P.READ])}`)
          .expect(200);
      const initial = await get();
      expect(initial.body.items).toHaveLength(2);
      expect(initial.body.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            orderLineId: f.lineId,
            productId: f.productId,
            skuSnapshot: sku,
            productNameSnapshot: 'QA product',
            unitSnapshot: 'PCS',
            quantity: '1.125',
            weight: '1.125',
            volume: '0.01125',
          }),
          expect.objectContaining({
            orderLineId: f.secondLineId,
            productId: f.secondProductId,
            skuSnapshot: 'QA-SECOND-SKU',
            productNameSnapshot: 'QA second product',
            unitSnapshot: 'BOX',
            quantity: '1.125',
            weight: '1.125',
            volume: '0.01125',
          }),
        ]),
      );
      expect(initial.body.warehouseSnapshot).toEqual({
        warehouseId: f.warehouseId,
        code: 'QA',
        name: 'QA warehouse',
      });
      expect(initial.body.deliveryAddressSnapshot).toMatchObject({
        recipientName: 'QA recipient',
        phone: null,
        province: 'QA province',
      });
      for (const [action, version, status] of [
        ['start-picking', 1, S.PICKING],
        ['mark-ready', 2, S.READY_TO_SHIP],
      ] as const) {
        await post(f.shipmentId, action, { version }).expect(200);
        const detail = await get();
        expect(detail.body).toMatchObject({ status, version: version + 1 });
        expect(detail.body.items).toEqual(initial.body.items);
        expect(detail.body.warehouseSnapshot).toEqual(
          initial.body.warehouseSnapshot,
        );
        expect(detail.body.statusHistory).toHaveLength(version + 1);
        const stale = await post(f.shipmentId, action, { version }).expect(409);
        expect(stale.body.details.reason).toBe('SHIPMENT_VERSION_CONFLICT');
      }
      const preparation = await stack
        .http()
        .get(
          `/api/v1/shipments?statuses=PENDING_PICK,PICKING&orderId=${f.orderId}`,
        )
        .set('Authorization', `Bearer ${stack.token([P.READ])}`)
        .expect(200);
      expect(preparation.body).toMatchObject({ items: [], total: 0 });
      const ready = await stack
        .http()
        .get(`/api/v1/shipments?status=READY_TO_SHIP&orderId=${f.orderId}`)
        .set('Authorization', `Bearer ${stack.token([P.READ])}`)
        .expect(200);
      expect(ready.body.total).toBe(1);
      expect(ready.body.items[0].id).toBe(f.shipmentId);
    }, 60_000);

    it.each([
      ['mark-delivered', S.DELIVERED, 'COMPLETED'],
      ['mark-failed', S.FAILED, 'DELIVERY_FAILED'],
    ] as const)(
      'preserves real dispatch preview, idempotent ISSUE and %s downstream contract',
      async (action, shipmentStatus, orderStatus) => {
        const f = await stack.seed();
        await post(f.shipmentId, 'start-picking', { version: 1 }).expect(200);
        await post(f.shipmentId, 'mark-ready', { version: 2 }).expect(200);
        await eventually(
          'Order ready before dispatch preview',
          () =>
            stack.orders.salesOrder.findUniqueOrThrow({
              where: { id: f.orderId },
            }),
          (row) => row.status === S.READY_TO_SHIP,
        );
        const path = `/api/v1/shipments/${f.shipmentId}`;
        const preview = await stack
          .http()
          .get(`${path}/dispatch-preview`)
          .set('Authorization', `Bearer ${stack.token([P.READ])}`)
          .expect(200);
        expect(preview.body).toMatchObject({
          shipmentId: f.shipmentId,
          orderId: f.orderId,
          version: 3,
        });
        const input = {
          version: preview.body.version,
          orderVersion: preview.body.orderVersion,
          requestId: randomUUID(),
          confirmed: true,
        };
        await post(f.shipmentId, 'dispatch', input, [P.READ]).expect(403);
        await post(f.shipmentId, 'dispatch', { ...input, confirmed: false }, [
          P.DISPATCH,
        ]).expect(400);
        const dispatched = await post(f.shipmentId, 'dispatch', input, [
          P.DISPATCH,
        ]).expect(200);
        expect(dispatched.body).toMatchObject({
          status: S.DISPATCHED,
          version: 4,
          dispatchIntent: { id: input.requestId, status: 'COMPLETED' },
        });
        await eventually(
          'Order dispatch projection',
          () =>
            stack.orders.salesOrder.findUniqueOrThrow({
              where: { id: f.orderId },
            }),
          (row) => row.status === 'IN_DELIVERY',
        );
        await eventually(
          'Inventory dispatch receipt',
          () =>
            stack.inventory.reservationGroup.findFirstOrThrow({
              where: { orderId: f.orderId },
            }),
          (row) => row.status === 'ISSUED',
        );
        const balance = await stack.inventory.inventoryBalance.findFirstOrThrow(
          {
            where: {
              tenantId: stack.tenantId,
              warehouseId: f.warehouseId,
              productId: f.productId,
            },
          },
        );
        expect(balance.onHandQuantity.toFixed()).toBe('9.375');
        expect(balance.reservedQuantity.toFixed()).toBe('0');
        const issue = await stack.inventory.stockMovement.findMany({
          where: {
            tenantId: stack.tenantId,
            referenceId: f.shipmentId,
            movementType: 'ISSUE',
          },
        });
        expect(issue).toHaveLength(1);
        expect(issue[0].quantityDelta.toFixed()).toBe('-1.125');
        await post(f.shipmentId, 'dispatch', input, [P.DISPATCH]).expect(200);
        const ready = await stack
          .http()
          .get(`/api/v1/shipments?status=READY_TO_SHIP&orderId=${f.orderId}`)
          .set('Authorization', `Bearer ${stack.token([P.READ])}`)
          .expect(200);
        expect(ready.body).toMatchObject({ items: [], total: 0 });
        const completeInput = {
          version: 4,
          confirmed: true,
          ...(action === 'mark-failed' && { reason: ' QA delivery failed ' }),
        };
        await post(f.shipmentId, action, completeInput, [P.READ]).expect(403);
        await post(
          f.shipmentId,
          action,
          { ...completeInput, confirmed: false },
          [P.COMPLETE],
        ).expect(400);
        if (action === 'mark-failed')
          await post(f.shipmentId, action, { ...completeInput, reason: ' ' }, [
            P.COMPLETE,
          ]).expect(400);
        await post(f.shipmentId, action, completeInput, [P.COMPLETE]).expect(
          200,
        );
        const detail = await stack
          .http()
          .get(path)
          .set('Authorization', `Bearer ${stack.token([P.READ])}`)
          .expect(200);
        expect(detail.body).toMatchObject({
          status: shipmentStatus,
          version: 5,
        });
        expect(detail.body.statusHistory).toHaveLength(5);
        if (action === 'mark-failed')
          expect(detail.body.failureReason).toBe('QA delivery failed');
        else expect(detail.body.deliveredAt).toEqual(expect.any(String));
        const stale = await post(f.shipmentId, action, completeInput, [
          P.COMPLETE,
        ]).expect(409);
        expect(stale.body.details.reason).toBe('SHIPMENT_VERSION_CONFLICT');
        await eventually(
          'Order completion projection',
          () =>
            stack.orders.salesOrder.findUniqueOrThrow({
              where: { id: f.orderId },
            }),
          (row) => row.status === orderStatus,
        );
        expect(
          await stack.inventory.inventoryBalance.findUniqueOrThrow({
            where: { id: balance.id },
          }),
        ).toEqual(balance);
        expect(
          await stack.inventory.stockMovement.findMany({
            where: {
              tenantId: stack.tenantId,
              referenceId: f.shipmentId,
              movementType: 'ISSUE',
            },
          }),
        ).toEqual(issue);
      },
      60_000,
    );

    it.each([
      ['start-picking', S.PENDING_PICK, 1, S.PICKING],
      ['mark-ready', S.PICKING, 2, S.READY_TO_SHIP],
    ] as const)(
      'serializes two concurrent %s requests with the same version',
      async (action, from, version, to) => {
        const f = await stack.seed();
        if (from === S.PICKING)
          await post(f.shipmentId, 'start-picking', { version: 1 }).expect(200);
        const before = await counts(f.shipmentId);
        const responses = await Promise.all([
          post(f.shipmentId, action, { version }),
          post(f.shipmentId, action, { version }),
        ]);
        expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
        expect(
          responses.find((r) => r.status === 409)?.body.details.reason,
        ).toBe('SHIPMENT_VERSION_CONFLICT');
        const row = await current(f.shipmentId);
        expect(row.status).toBe(to);
        expect(row.version).toBe(BigInt(version + 1));
        expect(await counts(f.shipmentId)).toEqual({
          history: before.history + 1,
          events: before.events + 1,
        });
        expect(
          await stack.fulfillment.shipmentStatusHistory.count({
            where: { shipmentId: row.id, shipmentVersion: row.version },
          }),
        ).toBe(1);
        expect(
          await stack.fulfillment.outboxEvent.count({
            where: { aggregateId: row.id, aggregateVersion: row.version },
          }),
        ).toBe(1);
      },
      60_000,
    );

    it.each([
      ['shipment_status_history', 'start-picking', 1],
      ['outbox_events', 'start-picking', 1],
      ['shipment_status_history', 'mark-ready', 2],
      ['outbox_events', 'mark-ready', 2],
    ] as const)(
      'rolls back status/version/readyAt when PostgreSQL rejects %s insert during %s',
      async (table, action, version) => {
        const f = await stack.seed();
        if (action === 'mark-ready')
          await post(f.shipmentId, 'start-picking', { version: 1 }).expect(200);
        const before = await current(f.shipmentId);
        const beforeCounts = await counts(f.shipmentId);
        const column =
          table === 'shipment_status_history' ? 'shipment_id' : 'aggregate_id';
        // Fixed SQL identifiers and generated UUID are confined to the disposable DB.
        await stack.sql.query(`
          CREATE FUNCTION fulfillment.qa_fail_write() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF NEW.${column} = '${f.shipmentId}'::uuid THEN
              RAISE EXCEPTION 'QA rollback proof';
            END IF;
            RETURN NEW;
          END $$;
          CREATE TRIGGER qa_fail_write BEFORE INSERT ON fulfillment.${table}
          FOR EACH ROW EXECUTE FUNCTION fulfillment.qa_fail_write();
        `);
        try {
          await post(f.shipmentId, action, { version }).expect(500);
          expect(await current(f.shipmentId)).toEqual(before);
          expect(await counts(f.shipmentId)).toEqual(beforeCounts);
        } finally {
          await stack.sql
            .query(`DROP TRIGGER qa_fail_write ON fulfillment.${table};
            DROP FUNCTION fulfillment.qa_fail_write();`);
        }
        await post(f.shipmentId, action, { version }).expect(200);
      },
      60_000,
    );

    it('enforces DTO/RBAC/tenant/pending-intent boundaries at the real controller', async () => {
      const f = await stack.seed();
      const before = await counts(f.shipmentId);
      for (const version of [
        undefined,
        0,
        -1,
        1.5,
        Number.MAX_SAFE_INTEGER + 1,
        '1',
      ]) {
        await post(f.shipmentId, 'start-picking', { version }).expect(400);
      }
      for (const extra of [{ confirmed: true }, { requestId: randomUUID() }]) {
        await post(f.shipmentId, 'start-picking', {
          version: 1,
          ...extra,
        }).expect(400);
      }
      for (const action of ['start-picking', 'mark-ready']) {
        await stack
          .http()
          .post(`/api/v1/shipments/${f.shipmentId}/${action}`)
          .send({ version: 1 })
          .expect(401);
        await post(f.shipmentId, action, { version: 1 }, [P.READ]).expect(403);
        await post(
          f.shipmentId,
          action,
          { version: 1 },
          [P.UPDATE],
          randomUUID(),
        ).expect(404);
      }
      const skipped = await post(f.shipmentId, 'mark-ready', {
        version: 1,
      }).expect(409);
      expect(skipped.body.details.reason).toBe('SHIPMENT_INVALID_TRANSITION');
      await stack.fulfillment.shipmentDispatchIntent.create({
        data: {
          id: randomUUID(),
          tenantId: stack.tenantId,
          shipmentId: f.shipmentId,
          shipmentVersion: 1n,
          orderVersion: 2n,
          actorId: stack.actorId,
          correlationId: randomUUID(),
          status: 'PENDING',
          nextAttemptAt: new Date(Date.now() + 3_600_000),
        },
      });
      for (const action of ['start-picking', 'mark-ready']) {
        const pending = await post(f.shipmentId, action, { version: 1 }).expect(
          409,
        );
        expect(pending.body.details.reason).toBe('SHIPMENT_DISPATCH_PENDING');
      }
      await stack.fulfillment.shipmentDispatchIntent.delete({
        where: { shipmentId: f.shipmentId },
      });
      expect(await counts(f.shipmentId)).toEqual(before);
    }, 60_000);

    it.each([S.READY_TO_SHIP, S.DISPATCHED, S.DELIVERED, S.FAILED, S.CANCELED])(
      'rejects pick and ready from %s without mutation',
      async (status) => {
        const f = await stack.seed();
        await stack.fulfillment.shipment.update({
          where: { id: f.shipmentId },
          data: { status },
        });
        const before = await counts(f.shipmentId);
        for (const action of ['start-picking', 'mark-ready']) {
          const response = await post(f.shipmentId, action, {
            version: 1,
          }).expect(409);
          expect(response.body.details.reason).toBe(
            'SHIPMENT_INVALID_TRANSITION',
          );
        }
        expect(await counts(f.shipmentId)).toEqual(before);
      },
      60_000,
    );
  },
);
