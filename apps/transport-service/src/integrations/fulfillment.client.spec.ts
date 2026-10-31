import { randomUUID } from 'node:crypto';
import { ServiceId } from '@logix/common';
import { verifyInternalServiceToken } from '@logix/auth';
import type { ConfigService } from '@nestjs/config';
import { FulfillmentClient } from './fulfillment.client.js';

describe('Fulfillment trip client', () => {
  const secret = 'b'.repeat(32);
  const tenantId = randomUUID();
  const warehouseId = randomUUID();
  afterEach(() => vi.unstubAllGlobals());

  it('retains the validated claim receipt when the successful response snapshot is malformed', async () => {
    const request = {
      contractVersion: 1 as const,
      tenantId,
      requestId: randomUUID(),
      tripId: randomUUID(),
      shipmentId: randomUUID(),
      actorId: randomUUID(),
      expectedTripVersion: 2,
      expectedShipmentVersion: 3,
    };
    const receipt = {
      contractVersion: 1,
      tenantId,
      requestId: request.requestId,
      tripId: request.tripId,
      shipmentId: request.shipmentId,
      claimId: randomUUID(),
      tripVersion: 2,
      shipmentVersion: 4,
      claimedAt: new Date().toISOString(),
      status: 'CLAIMED',
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      receipt,
      snapshot: { deliveryAddressSnapshot: {} },
    }), { status: 200 })));
    await expect(new FulfillmentClient(config()).claim(request))
      .rejects.toMatchObject({
        name: 'DownstreamError',
        definite: true,
        receipt,
      });
  });

  it('sends every local membership exclusion as a repeated internal query parameter before pagination', async () => {
    const excludedShipmentIds = [randomUUID(), randomUUID()];
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      items: [],
      total: 0,
      page: 2,
      pageSize: 20,
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const client = new FulfillmentClient(config());

    await expect(client.pool({
      tenantId,
      warehouseId,
      page: 2,
      pageSize: 20,
      excludedShipmentIds,
    })).resolves.toEqual({
      items: [],
      total: 0,
      page: 2,
      pageSize: 20,
    });

    const [url, options] = fetch.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe('/api/v1/internal/shipments/pool');
    expect(url.searchParams.getAll('excludedShipmentIds')).toEqual(excludedShipmentIds);
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.get('pageSize')).toBe('20');
    expect(options.method).toBe('GET');
    expectSignedToken(options, ServiceId.FULFILLMENT_SERVICE);
  });

  it('replays the exact persisted claim child payload through the signed internal endpoint', async () => {
    const request = {
      contractVersion: 1 as const,
      tenantId,
      requestId: randomUUID(),
      tripId: randomUUID(),
      shipmentId: randomUUID(),
      actorId: randomUUID(),
      expectedTripVersion: 9,
      expectedShipmentVersion: 3,
    };
    const addressId = randomUUID();
    const orderId = randomUUID();
    const occurredAt = new Date().toISOString();
    const receipt = {
      contractVersion: 1,
      tenantId,
      requestId: request.requestId,
      tripId: request.tripId,
      shipmentId: request.shipmentId,
      claimId: randomUUID(),
      tripVersion: 9,
      shipmentVersion: 4,
      claimedAt: occurredAt,
      status: 'CLAIMED',
    };
    const snapshot = {
      tenantId,
      shipmentId: request.shipmentId,
      shipmentNumber: 'SHP-0004',
      orderId,
      warehouseId,
      deliveryAddressSnapshot: {
        addressId,
        addressVersion: 2,
        addressType: 'SHIPPING',
        label: null,
        recipientName: 'Receiving',
        phone: null,
        addressLine: '1 Example Road',
        ward: null,
        district: null,
        province: 'Hanoi',
        postalCode: null,
        latitude: '21.000000',
        longitude: '105.000000',
        deliveryNote: null,
      },
      shipmentVersion: 4,
      orderVersion: 6,
      totalWeight: '3.500',
      totalVolume: '0.100000',
      items: [{
        orderLineId: randomUUID(),
        productId: randomUUID(),
        skuSnapshot: 'SKU-4',
        productNameSnapshot: 'Box',
        unitSnapshot: 'BOX',
        quantity: '2',
        weight: '3.500',
        volume: '0.100000',
      }],
    };
    const responseSnapshot = structuredClone(snapshot) as typeof snapshot & {
      privateMetadata?: string;
      deliveryAddressSnapshot: typeof snapshot.deliveryAddressSnapshot & {
        internalNotes?: string;
      };
      items: Array<(typeof snapshot.items)[number] & { internalCost?: string }>;
    };
    responseSnapshot.privateMetadata = 'must-not-leak';
    responseSnapshot.deliveryAddressSnapshot.internalNotes = 'must-not-leak';
    responseSnapshot.items[0].internalCost = 'must-not-leak';
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      receipt,
      snapshot: responseSnapshot,
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const client = new FulfillmentClient(config());

    await expect(client.claim(request)).resolves.toEqual({ receipt, snapshot });
    const [url, options] = fetch.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe('/api/v1/internal/shipments/claim');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body as string)).toEqual(request);
    expectSignedToken(options, ServiceId.FULFILLMENT_SERVICE);
  });

  function config() {
    return {
      getOrThrow: vi.fn((key: string) => ({
        FULFILLMENT_SERVICE_URL: 'http://fulfillment.test',
        INTERNAL_SERVICE_JWT_SECRET: secret,
      }[key])),
    } as unknown as ConfigService;
  }

  function expectSignedToken(options: RequestInit, audience: string) {
    const headers = options.headers as Record<string, string>;
    const token = headers['x-internal-service-token'];
    expect(verifyInternalServiceToken(token, {
      secret,
      audience,
      allowedIssuers: [ServiceId.TRANSPORT_SERVICE],
    })).toMatchObject({ tenantId });
  }
});
