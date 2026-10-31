import { randomUUID } from 'node:crypto';
import {
  INTERNAL_SERVICE_TOKEN_HEADER,
  signInternalServiceToken,
} from '@logix/auth';
import { ServiceId } from '@logix/common';
import {
  SHIPMENT_PERMISSIONS as P,
  SHIPMENT_STATUS as S,
} from '@logix/messaging';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, PickPackStack } from './pick-pack.stack.js';

describe.runIf(process.env.PICK_PACK_STACK_E2E === '1')(
  'Fulfillment trip claim HTTP and PostgreSQL persistence',
  () => {
    const stack = new PickPackStack();
    beforeAll(() => stack.start(), 240_000);
    afterAll(() => stack.close(), 90_000);

    const fulfillment = () => request(stack.url('fulfillment-service'));
    const internalToken = (
      tenantId: string = stack.tenantId,
      service: string = ServiceId.TRANSPORT_SERVICE,
    ) =>
      signInternalServiceToken({
        secret: stack.internalSecret,
        service,
        audience: ServiceId.FULFILLMENT_SERVICE,
        tenantId,
        ttlSeconds: 60,
      });
    const internalGet = (path: string, tenantId = stack.tenantId) =>
      fulfillment()
        .get(path)
        .set(INTERNAL_SERVICE_TOKEN_HEADER, internalToken(tenantId));
    const internalPost = (path: string, tenantId = stack.tenantId) =>
      fulfillment()
        .post(path)
        .set(INTERNAL_SERVICE_TOKEN_HEADER, internalToken(tenantId));
    const user = (permissions: string[]) =>
      `Bearer ${stack.token(permissions)}`;

    const prepareReady = async (shipmentId: string, orderId: string) => {
      const auth = user([P.UPDATE, P.READ, P.DISPATCH]);
      await fulfillment()
        .post(`/api/v1/shipments/${shipmentId}/start-picking`)
        .set('Authorization', auth)
        .send({ version: 1 })
        .expect(200);
      await fulfillment()
        .post(`/api/v1/shipments/${shipmentId}/mark-ready`)
        .set('Authorization', auth)
        .send({ version: 2 })
        .expect(200);
      await eventually(
        'Order READY_TO_SHIP projection',
        () =>
          stack.orders.salesOrder.findUniqueOrThrow({ where: { id: orderId } }),
        (order) => order.status === S.READY_TO_SHIP,
      );
      return auth;
    };

    it('claims with immutable snapshot, filters pool, rejects direct dispatch and releases a canceled tombstone', async () => {
      const fixture = await stack.seed('QA-TRIP-CLAIM', true);
      const publicAuth = user([P.UPDATE, P.READ, P.DISPATCH]);
      const picking = await fulfillment()
        .post(`/api/v1/shipments/${fixture.shipmentId}/start-picking`)
        .set('Authorization', publicAuth)
        .send({ version: 1 })
        .expect(200);
      expect(picking.body.status).toBe(S.PICKING);
      await fulfillment()
        .post(`/api/v1/shipments/${fixture.shipmentId}/mark-ready`)
        .set('Authorization', publicAuth)
        .send({ version: 2 })
        .expect(200);
      await eventually(
        'Order READY_TO_SHIP projection before claim',
        () =>
          stack.orders.salesOrder.findUniqueOrThrow({
            where: { id: fixture.orderId },
          }),
        (order) => order.status === S.READY_TO_SHIP,
      );

      const ready = await stack.fulfillment.shipment.findUniqueOrThrow({
        where: { id: fixture.shipmentId },
      });
      const orderBeforeClaim = await stack.orders.salesOrder.findUniqueOrThrow({
        where: { id: fixture.orderId },
      });
      const balanceBeforeClaim =
        await stack.inventory.inventoryBalance.findFirstOrThrow({
          where: {
            tenantId: stack.tenantId,
            productId: fixture.productId,
          },
        });
      const eventsBeforeClaim = await stack.fulfillment.outboxEvent.count({
        where: { aggregateId: fixture.shipmentId },
      });
      const requestId = randomUUID();
      const claimRequest = {
        contractVersion: 1,
        tenantId: stack.tenantId,
        requestId,
        tripId: randomUUID(),
        shipmentId: fixture.shipmentId,
        actorId: stack.actorId,
        expectedTripVersion: 8,
        expectedShipmentVersion: Number(ready.version),
      };
      const claimed = await internalPost('/api/v1/internal/shipments/claim')
        .send(claimRequest)
        .expect(200);
      expect(claimed.body).toMatchObject({
        receipt: {
          tenantId: stack.tenantId,
          requestId,
          shipmentId: fixture.shipmentId,
          tripVersion: 8,
          status: 'CLAIMED',
        },
        snapshot: {
          shipmentId: fixture.shipmentId,
          orderId: fixture.orderId,
          warehouseId: fixture.warehouseId,
          status: S.READY_TO_SHIP,
          deliveryAddressSnapshot: {
            addressLine: 'QA address',
            province: 'QA province',
          },
          totalWeight: '2.250',
          totalVolume: '0.022500',
          items: expect.arrayContaining([
            expect.objectContaining({
              skuSnapshot: 'QA-TRIP-CLAIM',
              quantity: '1.125',
              weight: '1.125',
              volume: '0.011250',
            }),
          ]),
        },
      });
      expect(claimed.body.snapshot.items).toHaveLength(2);

      const mirror = await stack.fulfillment.shipment.findUniqueOrThrow({
        where: { id: fixture.shipmentId },
      });
      expect(mirror).toMatchObject({
        assignedTripId: claimRequest.tripId,
        tripClaimId: claimed.body.receipt.claimId,
        version: BigInt(claimed.body.receipt.shipmentVersion),
      });
      const publicDetail = await fulfillment()
        .get(`/api/v1/shipments/${fixture.shipmentId}`)
        .set('Authorization', publicAuth)
        .expect(200);
      expect(publicDetail.body).not.toHaveProperty('tripClaimId');
      const persistedReceipt =
        await stack.fulfillment.shipmentTripReceipt.findUniqueOrThrow({
          where: {
            tenantId_requestId: {
              tenantId: stack.tenantId,
              requestId,
            },
          },
        });
      expect(persistedReceipt).toMatchObject({
        operation: 'CLAIM',
        actorId: stack.actorId,
        tripId: claimRequest.tripId,
      });

      const otherRequest = {
        ...claimRequest,
        requestId: randomUUID(),
        tenantId: randomUUID(),
      };
      await internalPost('/api/v1/internal/shipments/claim')
        .send(otherRequest)
        .expect(403);
      await fulfillment()
        .get(
          `/api/v1/internal/shipments/claims/${claimed.body.receipt.claimId}/status`,
        )
        .set(
          INTERNAL_SERVICE_TOKEN_HEADER,
          internalToken(stack.tenantId, ServiceId.ORDER_SERVICE),
        )
        .expect(401);

      const poolAvailable = await stack.fulfillment.shipment.create({
        data: {
          tenantId: stack.tenantId,
          shipmentNumber: `QA-POOL-${randomUUID()}`,
          orderId: randomUUID(),
          warehouseId: fixture.warehouseId,
          deliveryAddressId: randomUUID(),
          customerSnapshot: {},
          deliveryAddressSnapshot: {},
          warehouseSnapshot: { warehouseId: fixture.warehouseId },
          orderNumber: 'QA-POOL',
          confirmedOrderVersion: 1n,
          status: S.READY_TO_SHIP,
          totalWeight: '1.000',
          totalVolume: '0.010000',
          reservationGroupId: randomUUID(),
          createdAt: new Date('2026-10-01T00:00:00.000Z'),
        },
      });
      const poolExcluded = await stack.fulfillment.shipment.create({
        data: {
          tenantId: stack.tenantId,
          shipmentNumber: `QA-POOL-${randomUUID()}`,
          orderId: randomUUID(),
          warehouseId: fixture.warehouseId,
          deliveryAddressId: randomUUID(),
          customerSnapshot: {},
          deliveryAddressSnapshot: {},
          warehouseSnapshot: { warehouseId: fixture.warehouseId },
          orderNumber: 'QA-POOL',
          confirmedOrderVersion: 1n,
          status: S.READY_TO_SHIP,
          totalWeight: '2.000',
          totalVolume: '0.020000',
          reservationGroupId: randomUUID(),
          createdAt: new Date('2026-10-02T00:00:00.000Z'),
        },
      });
      const poolSecondPage = await stack.fulfillment.shipment.create({
        data: {
          tenantId: stack.tenantId,
          shipmentNumber: `QA-POOL-${randomUUID()}`,
          orderId: randomUUID(),
          warehouseId: fixture.warehouseId,
          deliveryAddressId: randomUUID(),
          customerSnapshot: {},
          deliveryAddressSnapshot: {},
          warehouseSnapshot: { warehouseId: fixture.warehouseId },
          orderNumber: 'QA-POOL',
          confirmedOrderVersion: 1n,
          status: S.READY_TO_SHIP,
          totalWeight: '2.500',
          totalVolume: '0.025000',
          reservationGroupId: randomUUID(),
          createdAt: new Date('2026-09-30T00:00:00.000Z'),
        },
      });
      const otherWarehouseId = randomUUID();
      const poolOtherWarehouse = await stack.fulfillment.shipment.create({
        data: {
          tenantId: stack.tenantId,
          shipmentNumber: `QA-POOL-${randomUUID()}`,
          orderId: randomUUID(),
          warehouseId: otherWarehouseId,
          deliveryAddressId: randomUUID(),
          customerSnapshot: {},
          deliveryAddressSnapshot: {},
          warehouseSnapshot: { warehouseId: otherWarehouseId },
          orderNumber: 'QA-POOL',
          confirmedOrderVersion: 1n,
          status: S.READY_TO_SHIP,
          totalWeight: '3.000',
          totalVolume: '0.030000',
          reservationGroupId: randomUUID(),
          createdAt: new Date('2026-10-03T00:00:00.000Z'),
        },
      });
      const pool = await internalGet('/api/v1/internal/shipments/pool')
        .query({
          contractVersion: 1,
          warehouseId: fixture.warehouseId,
          page: 1,
          pageSize: 1,
          excludedShipmentIds: [poolExcluded.id, randomUUID()],
        })
        .expect(200);
      expect(pool.body.items).toHaveLength(1);
      expect(pool.body.items[0].shipmentId).toBe(poolAvailable.id);
      expect(pool.body.total).toBe(2);
      expect(poolOtherWarehouse.warehouseId).not.toBe(fixture.warehouseId);
      const pageTwo = await internalGet('/api/v1/internal/shipments/pool')
        .query({
          contractVersion: 1,
          warehouseId: fixture.warehouseId,
          page: 2,
          pageSize: 1,
          excludedShipmentIds: [poolExcluded.id],
        })
        .expect(200);
      expect(pageTwo.body.total).toBe(2);
      expect(
        pageTwo.body.items.map((item: { shipmentId: string }) => item.shipmentId),
      ).toEqual([poolSecondPage.id]);

      const replay = await internalPost('/api/v1/internal/shipments/claim')
        .send(claimRequest)
        .expect(200);
      expect(replay.body).toEqual(claimed.body);
      await internalPost('/api/v1/internal/shipments/claim')
        .send({ ...claimRequest, actorId: randomUUID() })
        .expect(409);

      const status = await internalGet(
        `/api/v1/internal/shipments/claims/${claimed.body.receipt.claimId}/status`,
      ).expect(200);
      expect(status.body).toMatchObject({
        claimId: claimed.body.receipt.claimId,
        status: 'CLAIMED',
        snapshot: claimed.body.snapshot,
      });
      await internalGet(
        `/api/v1/internal/shipments/claims/${claimed.body.receipt.claimId}/status`,
        randomUUID(),
      ).expect(404);

      const preview = await fulfillment()
        .get(`/api/v1/shipments/${fixture.shipmentId}/dispatch-preview`)
        .set('Authorization', publicAuth)
        .expect(409);
      expect(preview.body.details?.reason).toBe('SHIPMENT_TRIP_CLAIM_CONFLICT');
      await fulfillment()
        .post(`/api/v1/shipments/${fixture.shipmentId}/dispatch`)
        .set('Authorization', publicAuth)
        .send({
          requestId: randomUUID(),
          version: claimed.body.receipt.shipmentVersion,
          orderVersion: Number(ready.confirmedOrderVersion),
          confirmed: true,
        })
        .expect(409);
      expect(
        await stack.fulfillment.shipmentDispatchIntent.count({
          where: { shipmentId: fixture.shipmentId },
        }),
      ).toBe(0);

      await stack.fulfillment.shipment.update({
        where: { id: fixture.shipmentId },
        data: { status: S.CANCELED },
      });
      const releaseRequest = {
        contractVersion: 1,
        tenantId: stack.tenantId,
        requestId: randomUUID(),
        claimId: claimed.body.receipt.claimId,
        tripId: claimRequest.tripId,
        shipmentId: fixture.shipmentId,
        actorId: stack.actorId,
        expectedTripVersion: 9,
        expectedShipmentVersion: claimed.body.receipt.shipmentVersion,
        reason: 'Trip canceled',
      };
      const released = await internalPost('/api/v1/internal/shipments/release')
        .send(releaseRequest)
        .expect(200);
      const releaseReplay = await internalPost(
        '/api/v1/internal/shipments/release',
      )
        .send(releaseRequest)
        .expect(200);
      expect(releaseReplay.body).toEqual(released.body);
      await internalPost('/api/v1/internal/shipments/release')
        .send({ ...releaseRequest, reason: 'Changed release payload' })
        .expect(409);
      expect(released.body).toMatchObject({
        receipt: {
          claimId: claimed.body.receipt.claimId,
          status: 'RELEASED',
        },
        snapshot: null,
      });
      const afterRelease = await stack.fulfillment.shipment.findUniqueOrThrow({
        where: { id: fixture.shipmentId },
      });
      expect(afterRelease).toMatchObject({
        status: S.CANCELED,
        assignedTripId: null,
        tripClaimId: null,
        version: BigInt(released.body.receipt.shipmentVersion),
      });
      expect(
        await stack.fulfillment.outboxEvent.count({
          where: { aggregateId: fixture.shipmentId },
        }),
      ).toBe(eventsBeforeClaim);
      const orderAfterRelease = await stack.orders.salesOrder.findUniqueOrThrow(
        {
          where: { id: fixture.orderId },
        },
      );
      const balanceAfterRelease =
        await stack.inventory.inventoryBalance.findUniqueOrThrow({
          where: { id: balanceBeforeClaim.id },
        });
      expect(orderAfterRelease).toMatchObject({
        status: orderBeforeClaim.status,
        version: orderBeforeClaim.version,
      });
      expect(balanceAfterRelease).toMatchObject({
        onHandQuantity: balanceBeforeClaim.onHandQuantity,
        reservedQuantity: balanceBeforeClaim.reservedQuantity,
      });
      const storedRelease = await internalGet(
        `/api/v1/internal/shipments/receipts/${releaseRequest.requestId}`,
      ).expect(200);
      expect(storedRelease.body).toEqual(released.body);
      const releasedStatus = await internalGet(
        `/api/v1/internal/shipments/claims/${claimed.body.receipt.claimId}/status`,
      ).expect(200);
      expect(releasedStatus.body.status).toBe('RELEASED');
      expect(releasedStatus.body.snapshot).toEqual(claimed.body.snapshot);
      expect(releasedStatus.body.releaseReceipt).toEqual(released.body.receipt);
    }, 90_000);

    it('serializes a real claim against direct dispatch on the Shipment row lock', async () => {
      const fixture = await stack.seed('QA-TRIP-DISPATCH-RACE', true);
      const publicAuth = await prepareReady(fixture.shipmentId, fixture.orderId);
      const ready = await stack.fulfillment.shipment.findUniqueOrThrow({
        where: { id: fixture.shipmentId },
      });
      const orderBefore = await stack.orders.salesOrder.findUniqueOrThrow({
        where: { id: fixture.orderId },
      });
      const balanceBefore = await stack.inventory.inventoryBalance.findFirstOrThrow({
        where: { tenantId: stack.tenantId, productId: fixture.productId },
      });
      const claim = {
        contractVersion: 1,
        tenantId: stack.tenantId,
        requestId: randomUUID(),
        tripId: randomUUID(),
        shipmentId: fixture.shipmentId,
        actorId: stack.actorId,
        expectedTripVersion: 1,
        expectedShipmentVersion: Number(ready.version),
      };
      const dispatch = {
        requestId: randomUUID(),
        version: Number(ready.version),
        orderVersion: Number(orderBefore.version),
        confirmed: true,
      };
      const [claimResponse, dispatchResponse] = await Promise.all([
        internalPost('/api/v1/internal/shipments/claim').send(claim),
        fulfillment()
          .post(`/api/v1/shipments/${fixture.shipmentId}/dispatch`)
          .set('Authorization', publicAuth)
          .send(dispatch),
      ]);
      expect([200, 409]).toContain(claimResponse.status);
      expect([200, 409]).toContain(dispatchResponse.status);
      expect(
        Number(claimResponse.status === 200) +
          Number(dispatchResponse.status === 200),
      ).toBe(1);

      const finalShipment = await eventually(
        'Claim/dispatch race final state',
        () =>
          stack.fulfillment.shipment.findUniqueOrThrow({
            where: { id: fixture.shipmentId },
          }),
        (row) =>
          row.status === S.DISPATCHED ||
          (row.status === S.READY_TO_SHIP && row.assignedTripId !== null),
      );
      if (claimResponse.status === 200) {
        expect(finalShipment).toMatchObject({
          status: S.READY_TO_SHIP,
          assignedTripId: claim.tripId,
          tripClaimId: claimResponse.body.receipt.claimId,
        });
        expect(dispatchResponse.status).toBe(409);
        expect(
          await stack.fulfillment.shipmentDispatchIntent.count({
            where: { shipmentId: fixture.shipmentId },
          }),
        ).toBe(0);
        expect(
          await stack.orders.salesOrder.findUniqueOrThrow({
            where: { id: fixture.orderId },
          }),
        ).toMatchObject({
          status: S.READY_TO_SHIP,
          version: orderBefore.version,
        });
      } else {
        expect(dispatchResponse.status).toBe(200);
        expect(finalShipment).toMatchObject({
          status: S.DISPATCHED,
          assignedTripId: null,
          tripClaimId: null,
        });
        expect(claimResponse.body.details?.reason).toBe(
          'SHIPMENT_TRIP_CLAIM_CONFLICT',
        );
        expect(
          await stack.fulfillment.shipmentDispatchIntent.count({
            where: { shipmentId: fixture.shipmentId, status: 'COMPLETED' },
          }),
        ).toBe(1);
      }
      const balanceAfter = await stack.inventory.inventoryBalance.findUniqueOrThrow({
        where: { id: balanceBefore.id },
      });
      if (claimResponse.status === 200) {
        expect(balanceAfter.onHandQuantity).toEqual(balanceBefore.onHandQuantity);
        expect(balanceAfter.reservedQuantity).toEqual(balanceBefore.reservedQuantity);
      } else {
        expect(Number(balanceAfter.reservedQuantity.toString())).toBeLessThan(
          Number(balanceBefore.reservedQuantity.toString()),
        );
      }
    }, 90_000);

    it('keeps an OrderCanceled tombstone under the claim row lock and release never revives readiness', async () => {
      const fixture = await stack.seed('QA-TRIP-CANCEL-RACE', true);
      await prepareReady(fixture.shipmentId, fixture.orderId);
      const ready = await stack.fulfillment.shipment.findUniqueOrThrow({
        where: { id: fixture.shipmentId },
      });
      const claim = {
        contractVersion: 1,
        tenantId: stack.tenantId,
        requestId: randomUUID(),
        tripId: randomUUID(),
        shipmentId: fixture.shipmentId,
        actorId: stack.actorId,
        expectedTripVersion: 1,
        expectedShipmentVersion: Number(ready.version),
      };
      const orderBeforeCancel = await stack.orders.salesOrder.findUniqueOrThrow({
        where: { id: fixture.orderId },
      });
      const cancelResponse = stack
        .http()
        .post(`/api/v1/orders/${fixture.orderId}/cancel`)
        .set('Authorization', user(['order:sales-order:cancel']))
        .send({
          version: Number(orderBeforeCancel.version),
          reason: 'Claim/cancel row lock race',
        });
      const [claimResponse, cancellation] = await Promise.all([
        internalPost('/api/v1/internal/shipments/claim').send(claim),
        cancelResponse,
      ]);
      expect([200, 409]).toContain(claimResponse.status);
      expect(cancellation.status).toBe(200);
      await eventually(
        'OrderCanceled shipment tombstone',
        () =>
          stack.fulfillment.shipment.findUniqueOrThrow({
            where: { id: fixture.shipmentId },
          }),
        (row) => row.status === S.CANCELED,
      );
      let canceled = await stack.fulfillment.shipment.findUniqueOrThrow({
        where: { id: fixture.shipmentId },
      });
      if (claimResponse.status === 200) {
        expect(canceled).toMatchObject({
          status: S.CANCELED,
          assignedTripId: claim.tripId,
          tripClaimId: claimResponse.body.receipt.claimId,
        });
        const release = await internalPost('/api/v1/internal/shipments/release')
          .send({
            contractVersion: 1,
            tenantId: stack.tenantId,
            requestId: randomUUID(),
            claimId: claimResponse.body.receipt.claimId,
            tripId: claim.tripId,
            shipmentId: fixture.shipmentId,
            actorId: stack.actorId,
            expectedTripVersion: 2,
            expectedShipmentVersion: Number(canceled.version),
            reason: 'Cleanup canceled claim',
          })
          .expect(200);
        expect(release.body.snapshot).toBeNull();
        canceled = await stack.fulfillment.shipment.findUniqueOrThrow({
          where: { id: fixture.shipmentId },
        });
        expect(canceled).toMatchObject({
          status: S.CANCELED,
          assignedTripId: null,
          tripClaimId: null,
        });
      } else {
        expect(canceled).toMatchObject({
          status: S.CANCELED,
          assignedTripId: null,
          tripClaimId: null,
        });
        expect(claimResponse.body.details?.reason).toBe(
          'SHIPMENT_TRIP_CLAIM_CONFLICT',
        );
      }
      const canceledOrder = await stack.orders.salesOrder.findUniqueOrThrow({
        where: { id: fixture.orderId },
      });
      expect(canceledOrder.status).toBe(S.CANCELED);
      expect(canceled.status).toBe(S.CANCELED);
    }, 90_000);

    it('preserves successful unclaimed direct dispatch and rejects an incomplete claim snapshot', async () => {
      const fixture = await stack.seed('QA-TRIP-DIRECT-UNCLAIMED', true);
      const publicAuth = await prepareReady(fixture.shipmentId, fixture.orderId);
      const ready = await stack.fulfillment.shipment.findUniqueOrThrow({
        where: { id: fixture.shipmentId },
      });
      const order = await stack.orders.salesOrder.findUniqueOrThrow({
        where: { id: fixture.orderId },
      });
      const dispatched = await fulfillment()
        .post(`/api/v1/shipments/${fixture.shipmentId}/dispatch`)
        .set('Authorization', publicAuth)
        .send({
          requestId: randomUUID(),
          version: Number(ready.version),
          orderVersion: Number(order.version),
          confirmed: true,
        })
        .expect(200);
      expect(dispatched.body.status).toBe(S.DISPATCHED);
      const unclaimedDispatch = await stack.fulfillment.shipment.findUniqueOrThrow({
        where: { id: fixture.shipmentId },
      });
      expect(unclaimedDispatch).toMatchObject({
        status: S.DISPATCHED,
        assignedTripId: null,
        tripClaimId: null,
      });

      const invalid = await stack.fulfillment.shipment.create({
        data: {
          tenantId: stack.tenantId,
          shipmentNumber: `QA-INV-${randomUUID()}`,
          orderId: randomUUID(),
          warehouseId: fixture.warehouseId,
          deliveryAddressId: randomUUID(),
          customerSnapshot: {},
          deliveryAddressSnapshot: {},
          warehouseSnapshot: { warehouseId: fixture.warehouseId },
          orderNumber: 'QA-INVALID-SNAPSHOT',
          confirmedOrderVersion: 1n,
          status: S.READY_TO_SHIP,
          totalWeight: '1.000',
          totalVolume: '0.010000',
          reservationGroupId: randomUUID(),
        },
      });
      const invalidClaim = await internalPost(
        '/api/v1/internal/shipments/claim',
      )
        .send({
          contractVersion: 1,
          tenantId: stack.tenantId,
          requestId: randomUUID(),
          tripId: randomUUID(),
          shipmentId: invalid.id,
          actorId: stack.actorId,
          expectedTripVersion: 1,
          expectedShipmentVersion: Number(invalid.version),
        })
        .expect(409);
      expect(invalidClaim.body.details?.reason).toBe(
        'SHIPMENT_SNAPSHOT_INVALID',
      );
      expect(
        await stack.fulfillment.shipmentTripReceipt.count({
          where: { shipmentId: invalid.id },
        }),
      ).toBe(0);
    }, 90_000);
  },
);
