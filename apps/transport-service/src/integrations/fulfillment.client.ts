import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { signInternalServiceToken } from '@logix/auth';
import { ServiceId } from '@logix/common';
import {
  decimal18_3Schema,
  decimal18_6Schema,
  shipmentClaimReceiptSchema,
  shipmentClaimRequestSchema,
  shipmentPoolPageSchema,
  shipmentReleaseReceiptSchema,
  shipmentReleaseRequestSchema,
  transportUuidSchema,
  transportVersionSchema,
  type ShipmentClaimRequest,
  type ShipmentReleaseRequest,
  batchDispatchGrantRequestSchema,
  shipmentDispatchBatchReceiptSchema,
  type BatchDispatchGrantRequest,
} from '@logix/messaging';
import { z } from 'zod';
import { DownstreamError, DownstreamServiceError } from './downstream-error.js';

export interface ShipmentClaimSnapshot {
  tenantId: string;
  shipmentId: string;
  shipmentNumber: string;
  orderId: string;
  warehouseId: string;
  deliveryAddressSnapshot: Record<string, unknown>;
  shipmentVersion: number;
  orderVersion: number;
  totalWeight: string;
  totalVolume: string;
  items: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

const addressSnapshotSchema = z.object({
  addressId: transportUuidSchema,
  addressVersion: transportVersionSchema,
  addressType: z.literal('SHIPPING'),
  label: z.string().nullable(),
  recipientName: z.string(),
  phone: z.string().nullable(),
  addressLine: z.string(),
  ward: z.string().nullable(),
  district: z.string().nullable(),
  province: z.string(),
  postalCode: z.string().nullable(),
  latitude: z.string().nullable(),
  longitude: z.string().nullable(),
  deliveryNote: z.string().nullable(),
});

const claimSnapshotSchema = z.object({
  tenantId: transportUuidSchema,
  shipmentId: transportUuidSchema,
  shipmentNumber: z.string().min(1),
  orderId: transportUuidSchema,
  warehouseId: transportUuidSchema,
  deliveryAddressSnapshot: addressSnapshotSchema,
  shipmentVersion: transportVersionSchema,
  orderVersion: transportVersionSchema,
  totalWeight: decimal18_3Schema,
  totalVolume: decimal18_6Schema,
  items: z.array(z.object({
    orderLineId: transportUuidSchema,
    productId: transportUuidSchema,
    skuSnapshot: z.string().min(1),
    productNameSnapshot: z.string().min(1),
    unitSnapshot: z.string().min(1),
    quantity: z.string().regex(/^(?!0+(?:\.0+)?$)\d{1,15}(?:\.\d{1,3})?$/),
    weight: decimal18_3Schema,
    volume: decimal18_6Schema,
  })),
});

export class InvalidClaimSnapshotError extends DownstreamError {
  constructor(
    readonly receipt: ReturnType<typeof shipmentClaimReceiptSchema.parse>,
  ) {
    super('Fulfillment returned an invalid claim snapshot', 502, true);
  }
}

@Injectable()
export class FulfillmentClient {
  constructor(private readonly config: ConfigService) {}

  async dispatchReadiness(tenantId: string, tripId: string, shipments: Array<{ shipmentId: string; shipmentVersion: number }>) {
    const response = await this.request('/internal/shipments/dispatch-readiness', tenantId, { tripId, shipments });
    return z.array(z.object({
      shipmentId: transportUuidSchema, shipmentVersion: transportVersionSchema, orderId: transportUuidSchema,
      orderVersion: transportVersionSchema, reservationGroupId: transportUuidSchema,
    }).strict()).parse(response);
  }

  async dispatchBatch(request: BatchDispatchGrantRequest) {
    batchDispatchGrantRequestSchema.parse(request);
    return shipmentDispatchBatchReceiptSchema.parse(
      await this.request('/internal/shipments/dispatch-batch', request.tenantId, request),
    );
  }

  async assertReady(tenantId: string, tripId: string, shipmentId: string, claimId: string, shipmentVersion: number): Promise<void> {
    const body = await this.request(`/internal/shipments/claims/${claimId}/status`, tenantId);
    const parsed = z.object({
      tenantId: transportUuidSchema,
      tripId: transportUuidSchema,
      shipmentId: transportUuidSchema,
      claimId: transportUuidSchema,
      status: z.literal('CLAIMED'),
      shipmentStatus: z.literal('READY_TO_SHIP'),
      shipmentVersion: transportVersionSchema,
    }).safeParse(body);
    if (!parsed.success || parsed.data.tenantId !== tenantId ||
      parsed.data.tripId !== tripId || parsed.data.shipmentId !== shipmentId ||
      parsed.data.claimId !== claimId || parsed.data.shipmentVersion !== shipmentVersion) {
      throw new DownstreamError('SHIPMENT_NOT_READY_OR_CLAIM_CHANGED', 409, true);
    }
  }

  async pool(input: {
    tenantId: string;
    warehouseId: string;
    page: number;
    pageSize: number;
    excludedShipmentIds: string[];
  }) {
    const query = new URLSearchParams({
      contractVersion: '1',
      warehouseId: input.warehouseId,
      page: String(input.page),
      pageSize: String(input.pageSize),
      status: 'READY_TO_SHIP',
    });
    for (const shipmentId of input.excludedShipmentIds) {
      query.append('excludedShipmentIds', shipmentId);
    }
    let body: unknown;
    try {
      body = await this.request(`/internal/shipments/pool?${query.toString()}`, input.tenantId);
    } catch (error) {
      if (error instanceof DownstreamError) {
        throw new DownstreamServiceError('Fulfillment', error.status);
      }
      throw error;
    }
    return shipmentPoolPageSchema.parse(body);
  }

  async claim(request: ShipmentClaimRequest): Promise<{
    receipt: ReturnType<typeof shipmentClaimReceiptSchema.parse>;
    snapshot: ShipmentClaimSnapshot;
  }> {
    shipmentClaimRequestSchema.parse(request);
    const body = await this.request('/internal/shipments/claim', request.tenantId, request);
    const result = body as { receipt: unknown; snapshot: unknown };
    const receipt = shipmentClaimReceiptSchema.parse(result.receipt);
    if (
      receipt.tenantId !== request.tenantId ||
      receipt.requestId !== request.requestId ||
      receipt.tripId !== request.tripId ||
      receipt.shipmentId !== request.shipmentId
    ) {
      throw new DownstreamError('Fulfillment returned an invalid claim receipt binding', 502, false);
    }
    const parsedSnapshot = claimSnapshotSchema.safeParse(result.snapshot);
    if (!parsedSnapshot.success) throw new InvalidClaimSnapshotError(receipt);
    const snapshot = parsedSnapshot.data as ShipmentClaimSnapshot;
    if (
      snapshot?.tenantId !== request.tenantId ||
      snapshot.shipmentId !== request.shipmentId ||
      snapshot.warehouseId === undefined ||
      snapshot.shipmentVersion !== receipt.shipmentVersion ||
      snapshot.orderVersion === undefined ||
      typeof snapshot.totalWeight !== 'string' ||
      typeof snapshot.totalVolume !== 'string' ||
      !snapshot.deliveryAddressSnapshot ||
      !Array.isArray(snapshot.items)
    ) {
      throw new InvalidClaimSnapshotError(receipt);
    }
    return { receipt, snapshot };
  }

  async release(request: ShipmentReleaseRequest) {
    shipmentReleaseRequestSchema.parse(request);
    const body = await this.request('/internal/shipments/release', request.tenantId, request);
    const result = body as { receipt: unknown; snapshot: unknown };
    return {
      receipt: shipmentReleaseReceiptSchema.parse(result.receipt),
      snapshot: result.snapshot,
    };
  }

  private async request(path: string, tenantId: string, body?: unknown): Promise<unknown> {
    const secret = this.config.getOrThrow<string>('INTERNAL_SERVICE_JWT_SECRET');
    const token = signInternalServiceToken({
      service: ServiceId.TRANSPORT_SERVICE,
      audience: ServiceId.FULFILLMENT_SERVICE,
      tenantId,
      secret,
      ttlSeconds: 60,
    });
    const base = this.config.getOrThrow<string>('FULFILLMENT_SERVICE_URL');
    let response: Response;
    try {
      response = await fetch(new URL(`/api/v1${path}`, base), {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          'x-internal-service-token': token,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (error) {
      throw new DownstreamError(
        error instanceof Error ? error.message : 'Fulfillment request failed',
        null,
        false,
      );
    }
    const result: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const payload = result as { message?: unknown } | null;
      throw new DownstreamError(
        typeof payload?.message === 'string'
          ? payload.message
          : `Fulfillment rejected the request (${response.status})`,
        response.status,
        response.status < 500 && response.status !== 408 && response.status !== 429,
      );
    }
    return result;
  }
}
