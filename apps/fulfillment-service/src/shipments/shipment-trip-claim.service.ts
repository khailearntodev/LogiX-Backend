import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  SHIPMENT_STATUS as S,
  assertShipmentClaimReceiptBinding,
  assertShipmentReleaseReceiptBinding,
  shipmentClaimReceiptSchema,
  shipmentClaimRequestSchema,
  shipmentReleaseReceiptSchema,
  shipmentReleaseRequestSchema,
  type ShipmentClaimRequest,
  type ShipmentReleaseRequest,
} from '@logix/messaging';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../database/prisma.service.js';
import {
  assertShipmentVersion,
  INTENT_STATUS,
  ShipmentErrors,
} from './shipment.domain.js';
import { lockShipment } from './shipment.persistence.js';
import { z } from 'zod';

const CLAIM = 'CLAIM';
const RELEASE = 'RELEASE';

export interface ShipmentTripSnapshot {
  tenantId: string;
  shipmentId: string;
  shipmentNumber: string;
  orderId: string;
  warehouseId: string;
  shipmentVersion: number;
  orderVersion: number;
  status: 'READY_TO_SHIP';
  deliveryAddressSnapshot: Prisma.JsonValue;
  totalWeight: string;
  totalVolume: string;
  items: Array<{
    orderLineId: string;
    productId: string;
    skuSnapshot: string;
    productNameSnapshot: string;
    unitSnapshot: string;
    quantity: string;
    weight: string;
    volume: string;
  }>;
}

export interface ShipmentClaimResponse {
  receipt: ReturnType<typeof shipmentClaimReceiptSchema.parse>;
  snapshot: ShipmentTripSnapshot;
}

export interface ShipmentReleaseResponse {
  receipt: ReturnType<typeof shipmentReleaseReceiptSchema.parse>;
  snapshot: null;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => left.localeCompare(right),
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function version(value: bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1)
    throw new Error('Shipment version exceeds safe integer range');
  return result;
}

function snapshot(
  shipment: Prisma.ShipmentGetPayload<{ include: { items: true } }>,
): ShipmentTripSnapshot {
  const decimal = (value: Prisma.Decimal, places: number) =>
    new Prisma.Decimal(value.toString()).toFixed(places);
  return {
    tenantId: shipment.tenantId,
    shipmentId: shipment.id,
    shipmentNumber: shipment.shipmentNumber,
    orderId: shipment.orderId,
    warehouseId: shipment.warehouseId,
    shipmentVersion: version(shipment.version),
    orderVersion: version(shipment.confirmedOrderVersion),
    status: 'READY_TO_SHIP',
    deliveryAddressSnapshot:
      shipment.deliveryAddressSnapshot as Prisma.JsonValue,
    totalWeight: decimal(shipment.totalWeight, 3),
    totalVolume: decimal(shipment.totalVolume, 6),
    items: shipment.items
      .filter((item) => item.deletedAt === null)
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((item) => ({
        orderLineId: item.orderLineId,
        productId: item.productId,
        skuSnapshot: item.skuSnapshot,
        productNameSnapshot: item.productNameSnapshot,
        unitSnapshot: item.unitSnapshot,
        quantity: decimal(item.quantity, 3),
        weight: decimal(item.weight, 3),
        volume: decimal(item.volume, 6),
      })),
  };
}

function assertSnapshot(shipment: {
  deliveryAddressId: string;
  deliveryAddressSnapshot: Prisma.JsonValue;
  items: Array<{
    deletedAt: Date | null;
    quantity: Prisma.Decimal;
    weight: Prisma.Decimal;
    volume: Prisma.Decimal;
  }>;
}): void {
  const address = z
    .object({
      addressId: z.string().uuid(),
      addressVersion: z.number().int().positive().safe(),
      addressType: z.literal('SHIPPING'),
      label: z.string().nullable(),
      recipientName: z.string().trim().min(1),
      phone: z.string().nullable(),
      addressLine: z.string().trim().min(1),
      ward: z.string().nullable(),
      district: z.string().nullable(),
      province: z.string().trim().min(1),
      postalCode: z.string().nullable(),
      latitude: z.string().nullable(),
      longitude: z.string().nullable(),
      deliveryNote: z.string().nullable(),
    })
    .strict()
    .safeParse(shipment.deliveryAddressSnapshot);
  const activeItems = shipment.items.filter((item) => item.deletedAt === null);
  if (
    !address.success ||
    address.data.addressId !== shipment.deliveryAddressId ||
    activeItems.length === 0 ||
    activeItems.some(
      (item) => {
        const quantity = Number(item.quantity.toString());
        const weight = Number(item.weight.toString());
        const volume = Number(item.volume.toString());
        return (
          !Number.isFinite(quantity) ||
          quantity <= 0 ||
          !Number.isFinite(weight) ||
          weight < 0 ||
          !Number.isFinite(volume) ||
          volume < 0
        );
      },
    )
  )
    throw ShipmentErrors.snapshotInvalid();
}

function storedResponse<T>(value: Prisma.JsonValue): T {
  return value as T;
}

@Injectable()
export class ShipmentTripClaimService {
  constructor(private readonly prisma: PrismaService) {}

  async claim(request: ShipmentClaimRequest): Promise<ShipmentClaimResponse> {
    const payload = shipmentClaimRequestSchema.parse(request);
    const claimId = randomUUID();

    try {
      return await this.prisma.$transaction(async (tx) => {
        await lockShipment(tx, payload.tenantId, payload.shipmentId);
        const prior = await tx.shipmentTripReceipt.findUnique({
          where: {
            tenantId_requestId: {
              tenantId: payload.tenantId,
              requestId: payload.requestId,
            },
          },
        });
        if (prior) {
          if (
            prior.operation !== CLAIM ||
            stableJson(prior.requestPayload) !== stableJson(payload)
          )
            throw ShipmentErrors.tripRequestConflict();
          return storedResponse<ShipmentClaimResponse>(prior.responsePayload);
        }

        const current = await tx.shipment.findFirst({
          where: {
            id: payload.shipmentId,
            tenantId: payload.tenantId,
            deletedAt: null,
          },
          include: {
            items: { where: { deletedAt: null } },
            dispatchIntent: true,
          },
        });
        if (!current) throw ShipmentErrors.missing();
        assertShipmentVersion(current.version, payload.expectedShipmentVersion);
        if (
          current.status !== S.READY_TO_SHIP ||
          current.assignedTripId !== null ||
          current.tripClaimId !== null ||
          (current.dispatchIntent !== null &&
            current.dispatchIntent.status !== INTENT_STATUS.REJECTED)
        )
          throw ShipmentErrors.tripClaimConflict();
        assertSnapshot(current);

        const updated = await tx.shipment.update({
          where: { id: current.id, tenantId: payload.tenantId },
          data: {
            assignedTripId: payload.tripId,
            tripClaimId: claimId,
            version: { increment: 1 },
          },
          include: { items: { where: { deletedAt: null } } },
        });
        const receipt = shipmentClaimReceiptSchema.parse({
          contractVersion: payload.contractVersion,
          tenantId: payload.tenantId,
          requestId: payload.requestId,
          tripId: payload.tripId,
          shipmentId: payload.shipmentId,
          claimId,
          tripVersion: payload.expectedTripVersion,
          shipmentVersion: version(updated.version),
          claimedAt: new Date().toISOString(),
          status: 'CLAIMED',
        });
        assertShipmentClaimReceiptBinding(payload, receipt);
        const response = { receipt, snapshot: snapshot(updated) };
        await tx.shipmentTripReceipt.create({
          data: {
            tenantId: payload.tenantId,
            requestId: payload.requestId,
            shipmentId: payload.shipmentId,
            tripId: payload.tripId,
            claimId,
            actorId: payload.actorId,
            operation: CLAIM,
            requestPayload: payload as Prisma.InputJsonValue,
            responsePayload: response as unknown as Prisma.InputJsonValue,
          },
        });
        return response;
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      )
        throw ShipmentErrors.tripRequestConflict();
      throw error;
    }
  }

  async release(
    request: ShipmentReleaseRequest,
  ): Promise<ShipmentReleaseResponse> {
    const payload = shipmentReleaseRequestSchema.parse(request);

    try {
      return await this.prisma.$transaction(async (tx) => {
        await lockShipment(tx, payload.tenantId, payload.shipmentId);
        const prior = await tx.shipmentTripReceipt.findUnique({
          where: {
            tenantId_requestId: {
              tenantId: payload.tenantId,
              requestId: payload.requestId,
            },
          },
        });
        if (prior) {
          if (
            prior.operation !== RELEASE ||
            stableJson(prior.requestPayload) !== stableJson(payload)
          )
            throw ShipmentErrors.tripRequestConflict();
          return storedResponse<ShipmentReleaseResponse>(prior.responsePayload);
        }

        const current = await tx.shipment.findFirst({
          where: {
            id: payload.shipmentId,
            tenantId: payload.tenantId,
            deletedAt: null,
          },
          include: { dispatchIntent: true },
        });
        if (!current) throw ShipmentErrors.missing();
        const original = await tx.shipmentTripReceipt.findFirst({
          where: {
            tenantId: payload.tenantId,
            claimId: payload.claimId,
            operation: CLAIM,
          },
        });
        if (!original) throw ShipmentErrors.tripClaimConflict();
        const originalRequest = shipmentClaimRequestSchema.parse(
          original.requestPayload,
        );
        const originalResponse = storedResponse<ShipmentClaimResponse>(
          original.responsePayload,
        );
        if (
          original.shipmentId !== payload.shipmentId ||
          original.tripId !== payload.tripId ||
          original.actorId !== payload.actorId ||
          originalRequest.tenantId !== payload.tenantId ||
          originalRequest.tripId !== payload.tripId ||
          originalRequest.shipmentId !== payload.shipmentId ||
          originalRequest.actorId !== payload.actorId ||
          originalResponse.receipt.claimId !== payload.claimId
        )
          throw ShipmentErrors.tripClaimConflict();

        assertShipmentVersion(current.version, payload.expectedShipmentVersion);
        const releasableStatuses: string[] = [S.READY_TO_SHIP, S.CANCELED];
        if (
          current.tripClaimId !== payload.claimId ||
          current.assignedTripId !== payload.tripId ||
          (current.dispatchIntent !== null &&
            current.dispatchIntent.status !== INTENT_STATUS.REJECTED) ||
          current.dispatchIssuedAt !== null ||
          !releasableStatuses.includes(current.status)
        )
          throw ShipmentErrors.tripClaimConflict();

        const updated = await tx.shipment.update({
          where: { id: current.id, tenantId: payload.tenantId },
          data: {
            assignedTripId: null,
            tripClaimId: null,
            version: { increment: 1 },
          },
        });
        const receipt = shipmentReleaseReceiptSchema.parse({
          contractVersion: payload.contractVersion,
          tenantId: payload.tenantId,
          requestId: payload.requestId,
          claimId: payload.claimId,
          tripId: payload.tripId,
          shipmentId: payload.shipmentId,
          tripVersion: payload.expectedTripVersion,
          shipmentVersion: version(updated.version),
          releasedAt: new Date().toISOString(),
          status: 'RELEASED',
        });
        assertShipmentReleaseReceiptBinding(payload, receipt);
        const response: ShipmentReleaseResponse = { receipt, snapshot: null };
        await tx.shipmentTripReceipt.create({
          data: {
            tenantId: payload.tenantId,
            requestId: payload.requestId,
            shipmentId: payload.shipmentId,
            tripId: payload.tripId,
            claimId: payload.claimId,
            actorId: payload.actorId,
            operation: RELEASE,
            requestPayload: payload as Prisma.InputJsonValue,
            responsePayload: response as unknown as Prisma.InputJsonValue,
          },
        });
        return response;
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      )
        throw ShipmentErrors.tripRequestConflict();
      throw error;
    }
  }

  async receipt(tenantId: string, requestId: string) {
    const row = await this.prisma.shipmentTripReceipt.findUnique({
      where: { tenantId_requestId: { tenantId, requestId } },
    });
    if (!row) throw ShipmentErrors.missing();
    return storedResponse(row.responsePayload);
  }

  async claimStatus(tenantId: string, claimId: string) {
    const claim = await this.prisma.shipmentTripReceipt.findFirst({
      where: { tenantId, claimId, operation: CLAIM },
      include: {
        shipment: {
          include: {
            tripReceipts: {
              where: { operation: RELEASE, claimId },
              orderBy: { createdAt: 'desc' },
              take: 1,
            },
          },
        },
      },
    });
    if (!claim) throw ShipmentErrors.missing();
    const releaseRecord = claim.shipment.tripReceipts[0];
    const active =
      claim.shipment.tripClaimId === claimId &&
      claim.shipment.assignedTripId === claim.tripId;
    if (!active && !releaseRecord) throw ShipmentErrors.tripClaimConflict();
    const originalResponse = storedResponse<ShipmentClaimResponse>(
      claim.responsePayload,
    );
    return {
      tenantId,
      claimId,
      tripId: claim.tripId,
      shipmentId: claim.shipmentId,
      status: active ? 'CLAIMED' : 'RELEASED',
      shipmentStatus: claim.shipment.status,
      shipmentVersion: version(claim.shipment.version),
      receipt: originalResponse.receipt,
      snapshot: originalResponse.snapshot,
      releaseReceipt: releaseRecord
        ? storedResponse<ShipmentReleaseResponse>(
            releaseRecord.responsePayload,
          ).receipt
        : null,
    };
  }
}
