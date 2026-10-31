import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../database/prisma.service.js';
import type {
  ShipmentClaimRequest,
  ShipmentReleaseRequest,
} from '@logix/messaging';
import { ShipmentTripClaimService } from './shipment-trip-claim.service.js';

interface ReceiptRecord {
  tenantId: string;
  requestId: string;
  shipmentId: string;
  tripId: string;
  claimId: string;
  actorId: string;
  operation: string;
  requestPayload: unknown;
  responsePayload: unknown;
}

function setup() {
  const tenantId = randomUUID();
  const deliveryAddressId = randomUUID();
  const shipment = {
    id: randomUUID(),
    tenantId,
    shipmentNumber: 'SHP-1',
    orderId: randomUUID(),
    warehouseId: randomUUID(),
    deliveryAddressId,
    deliveryAddressSnapshot: {
      addressId: deliveryAddressId,
      addressVersion: 1,
      addressType: 'SHIPPING',
      label: null,
      recipientName: 'QA recipient',
      phone: null,
      addressLine: 'Original address',
      ward: null,
      district: null,
      province: 'Hanoi',
      postalCode: null,
      latitude: null,
      longitude: null,
      deliveryNote: null,
    },
    confirmedOrderVersion: 7n,
    status: 'READY_TO_SHIP',
    totalWeight: { toString: () => '1.125' },
    totalVolume: { toString: () => '0.011250' },
    assignedTripId: null as string | null,
    tripClaimId: null as string | null,
    dispatchIssuedAt: null as Date | null,
    version: 3n,
    deletedAt: null,
    dispatchIntent: null as { status: string } | null,
    items: [
      {
        id: randomUUID(),
        orderLineId: randomUUID(),
        productId: randomUUID(),
        skuSnapshot: 'QA-SKU',
        productNameSnapshot: 'QA item',
        unitSnapshot: 'PCS',
        quantity: { toString: () => '1.125' },
        weight: { toString: () => '1.125' },
        volume: { toString: () => '0.011250' },
        deletedAt: null,
      },
    ],
  };
  const receipts: ReceiptRecord[] = [];
  const tx = {
    $queryRaw: vi.fn(),
    shipment: {
      findFirst: vi.fn(async () => shipment),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if ('assignedTripId' in data)
          shipment.assignedTripId = data.assignedTripId as string | null;
        if ('tripClaimId' in data)
          shipment.tripClaimId = data.tripClaimId as string | null;
        if ('dispatchIssuedAt' in data)
          shipment.dispatchIssuedAt = data.dispatchIssuedAt as Date | null;
        shipment.version += 1n;
        return shipment;
      }),
    },
    shipmentTripReceipt: {
      findUnique: vi.fn(
        async ({
          where,
        }: {
          where: {
            tenantId_requestId: { tenantId: string; requestId: string };
          };
        }) =>
          receipts.find(
            (row) =>
              row.tenantId === where.tenantId_requestId.tenantId &&
              row.requestId === where.tenantId_requestId.requestId,
          ) ?? null,
      ),
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where: { tenantId: string; claimId: string; operation: string };
        }) =>
          receipts.find(
            (row) =>
              row.tenantId === where.tenantId &&
              row.claimId === where.claimId &&
              row.operation === where.operation,
          ) ?? null,
      ),
      create: vi.fn(async ({ data }: { data: ReceiptRecord }) => {
        receipts.push(data);
        return data;
      }),
    },
  };
  const prisma = {
    $transaction: vi.fn(
      async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
    ),
  };
  return {
    tenantId,
    shipment,
    receipts,
    tx,
    service: new ShipmentTripClaimService(prisma as unknown as PrismaService),
  };
}

function claimRequest(
  tenantId: string,
  shipmentId: string,
): ShipmentClaimRequest {
  return {
    contractVersion: 1,
    tenantId,
    requestId: randomUUID(),
    tripId: randomUUID(),
    shipmentId,
    actorId: randomUUID(),
    expectedTripVersion: 4,
    expectedShipmentVersion: 3,
  };
}

describe('Fulfillment trip claims', () => {
  it('locks and claims a ready shipment with immutable exact snapshot and receipt', async () => {
    const s = setup();
    const request = claimRequest(s.tenantId, s.shipment.id);
    const result = await s.service.claim(request);

    expect(s.tx.$queryRaw).toHaveBeenCalledOnce();
    expect(result.receipt).toMatchObject({
      tenantId: request.tenantId,
      requestId: request.requestId,
      tripId: request.tripId,
      shipmentId: request.shipmentId,
      tripVersion: request.expectedTripVersion,
      shipmentVersion: 4,
      status: 'CLAIMED',
    });
    expect(result.snapshot).toMatchObject({
      shipmentId: request.shipmentId,
      orderVersion: 7,
      shipmentVersion: 4,
      deliveryAddressSnapshot: {
        addressLine: 'Original address',
      },
      totalWeight: '1.125',
      totalVolume: '0.011250',
      items: [
        expect.objectContaining({
          skuSnapshot: 'QA-SKU',
          quantity: '1.125',
          volume: '0.011250',
        }),
      ],
    });
    expect(s.shipment).toMatchObject({
      assignedTripId: request.tripId,
      tripClaimId: result.receipt.claimId,
      version: 4n,
    });
    expect(s.receipts).toHaveLength(1);
    expect(s.receipts[0]).toMatchObject({
      operation: 'CLAIM',
      actorId: request.actorId,
      requestPayload: request,
    });
  });

  it('replays the exact receipt before current version/state validation', async () => {
    const s = setup();
    const request = claimRequest(s.tenantId, s.shipment.id);
    const first = await s.service.claim(request);
    s.shipment.status = 'DISPATCHED';
    s.shipment.version = 90n;

    const replay = await s.service.claim(request);

    expect(replay).toEqual(first);
    expect(s.receipts).toHaveLength(1);
    expect(s.shipment.version).toBe(90n);
  });

  it('rejects stale claim versions without reserving the request key', async () => {
    const s = setup();
    const request = claimRequest(s.tenantId, s.shipment.id);
    await expect(
      s.service.claim({ ...request, expectedShipmentVersion: 2 }),
    ).rejects.toMatchObject({ reason: 'SHIPMENT_VERSION_CONFLICT' });
    expect(s.receipts).toHaveLength(0);
    expect(s.shipment.assignedTripId).toBeNull();
  });

  it('rejects a reused tenant request key with changed actor or payload', async () => {
    const s = setup();
    const request = claimRequest(s.tenantId, s.shipment.id);
    await s.service.claim(request);

    await expect(
      s.service.claim({ ...request, actorId: randomUUID() }),
    ).rejects.toMatchObject({ reason: 'SHIPMENT_TRIP_REQUEST_CONFLICT' });
  });

  it.each([
    ['not ready', { status: 'PICKING' }],
    ['already assigned', { assignedTripId: randomUUID() }],
    ['has claim id without trip mirror', { tripClaimId: randomUUID() }],
    ['dispatch intent is pending', { dispatchIntent: { status: 'PENDING' } }],
  ])('rejects claim when shipment is %s', async (_name, patch) => {
    const s = setup();
    Object.assign(s.shipment, patch);
    await expect(
      s.service.claim(claimRequest(s.tenantId, s.shipment.id)),
    ).rejects.toMatchObject({ reason: 'SHIPMENT_TRIP_CLAIM_CONFLICT' });
    expect(s.receipts).toHaveLength(0);
  });

  it('allows a claim after a direct-dispatch attempt was definitively rejected', async () => {
    const s = setup();
    s.shipment.dispatchIntent = { status: 'REJECTED' };

    const result = await s.service.claim(
      claimRequest(s.tenantId, s.shipment.id),
    );

    expect(result.receipt.status).toBe('CLAIMED');
  });

  it('rejects claim when immutable address or item demand snapshot is missing', async () => {
    const s = setup();
    Object.assign(s.shipment, { deliveryAddressSnapshot: {} });
    await expect(
      s.service.claim(claimRequest(s.tenantId, s.shipment.id)),
    ).rejects.toMatchObject({ reason: 'SHIPMENT_SNAPSHOT_INVALID' });
    expect(s.shipment.assignedTripId).toBeNull();
    expect(s.receipts).toHaveLength(0);

    Object.assign(s.shipment, {
      deliveryAddressSnapshot: {
        addressId: s.shipment.deliveryAddressId,
        addressVersion: 1,
        addressType: 'SHIPPING',
        label: null,
        recipientName: 'QA recipient',
        phone: null,
        addressLine: 'Original address',
        ward: null,
        district: null,
        province: 'Hanoi',
        postalCode: null,
        latitude: null,
        longitude: null,
        deliveryNote: null,
      },
    });
    s.shipment.items = [];
    await expect(
      s.service.claim(claimRequest(s.tenantId, s.shipment.id)),
    ).rejects.toMatchObject({ reason: 'SHIPMENT_SNAPSHOT_INVALID' });
    expect(s.shipment.assignedTripId).toBeNull();
    expect(s.receipts).toHaveLength(0);
  });

  it('releases only the original claim and keeps a canceled tombstone canceled', async () => {
    const s = setup();
    const request = claimRequest(s.tenantId, s.shipment.id);
    const claimed = await s.service.claim(request);
    s.shipment.status = 'CANCELED';
    const release: ShipmentReleaseRequest = {
      contractVersion: 1,
      tenantId: request.tenantId,
      requestId: randomUUID(),
      claimId: claimed.receipt.claimId,
      tripId: request.tripId,
      shipmentId: request.shipmentId,
      actorId: request.actorId,
      expectedTripVersion: 5,
      expectedShipmentVersion: 4,
      reason: 'Trip canceled',
    };

    const result = await s.service.release(release);

    expect(result.receipt).toMatchObject({
      claimId: claimed.receipt.claimId,
      status: 'RELEASED',
      shipmentVersion: 5,
    });
    expect(result.snapshot).toBeNull();
    expect(s.shipment).toMatchObject({
      status: 'CANCELED',
      assignedTripId: null,
      tripClaimId: null,
      version: 5n,
    });
    expect(s.receipts[1]).toMatchObject({
      operation: 'RELEASE',
      actorId: request.actorId,
      requestPayload: release,
    });
  });

  it('replays release before checking a cleared mirror or newer shipment version', async () => {
    const s = setup();
    const claim = claimRequest(s.tenantId, s.shipment.id);
    const claimed = await s.service.claim(claim);
    const release: ShipmentReleaseRequest = {
      contractVersion: 1,
      tenantId: claim.tenantId,
      requestId: randomUUID(),
      claimId: claimed.receipt.claimId,
      tripId: claim.tripId,
      shipmentId: claim.shipmentId,
      actorId: claim.actorId,
      expectedTripVersion: 5,
      expectedShipmentVersion: 4,
      reason: 'Remove shipment',
    };
    const first = await s.service.release(release);
    s.shipment.version = 72n;
    s.shipment.status = 'DISPATCHED';

    const replay = await s.service.release(release);

    expect(replay).toEqual(first);
    expect(s.receipts).toHaveLength(2);
    expect(s.shipment.version).toBe(72n);
  });

  it('rejects release with changed payload under an existing request key', async () => {
    const s = setup();
    const claim = claimRequest(s.tenantId, s.shipment.id);
    const claimed = await s.service.claim(claim);
    const release: ShipmentReleaseRequest = {
      contractVersion: 1,
      tenantId: claim.tenantId,
      requestId: randomUUID(),
      claimId: claimed.receipt.claimId,
      tripId: claim.tripId,
      shipmentId: claim.shipmentId,
      actorId: claim.actorId,
      expectedTripVersion: 5,
      expectedShipmentVersion: 4,
      reason: 'Remove shipment',
    };
    await s.service.release(release);

    await expect(
      s.service.release({ ...release, reason: 'Different reason' }),
    ).rejects.toMatchObject({ reason: 'SHIPMENT_TRIP_REQUEST_CONFLICT' });
  });

  it.each([
    ['dispatch grant was issued', { dispatchIssuedAt: new Date() }],
    ['Shipment is terminal', { status: 'DISPATCHED' }],
    ['direct dispatch is pending', { dispatchIntent: { status: 'PENDING' } }],
  ])('does not release after %s', async (_name, patch) => {
    const s = setup();
    const request = claimRequest(s.tenantId, s.shipment.id);
    const claimed = await s.service.claim(request);
    Object.assign(s.shipment, patch);
    const release: ShipmentReleaseRequest = {
      contractVersion: 1,
      tenantId: request.tenantId,
      requestId: randomUUID(),
      claimId: claimed.receipt.claimId,
      tripId: request.tripId,
      shipmentId: request.shipmentId,
      actorId: request.actorId,
      expectedTripVersion: 5,
      expectedShipmentVersion: 4,
      reason: 'Canceled',
    };

    await expect(s.service.release(release)).rejects.toMatchObject({
      reason: 'SHIPMENT_TRIP_CLAIM_CONFLICT',
    });
    expect(s.shipment.assignedTripId).toBe(request.tripId);
    expect(s.receipts).toHaveLength(1);
  });
});
