import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  INTERNAL_SERVICE_TOKEN_HEADER,
  signInternalServiceToken,
} from '@logix/auth';
import { ServiceId } from '@logix/common';
import type {
  ReservationPreview,
  ReserveRequest,
  ReserveResult,
} from '@logix/messaging';
import { z } from 'zod';
import { OrderErrors } from '../domain/order-errors.js';
import type { OrderCommandContext } from '../order.types.js';

const INTERNAL_TOKEN_TTL_SECONDS = 60;
export const INVENTORY_REQUEST_TIMEOUT_MS = 5_000;
const quantity = z.string().regex(/^\d{1,15}(?:\.\d{1,3})?$/);
const shortage = z.object({
  productId: z.string().uuid(),
  required: quantity,
  available: quantity,
});
const reserveResult = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('RESERVED'),
    reservationGroupId: z.string().uuid(),
  }),
  z.object({
    outcome: z.literal('INSUFFICIENT'),
    shortages: z.array(shortage).nonempty(),
  }),
]);
const previewResult = z.object({
  checkedAt: z.string().datetime(),
  lines: z.array(shortage.extend({ sufficient: z.boolean() })).nonempty(),
});
type RequestContext = Pick<OrderCommandContext, 'tenantId' | 'correlationId'>;

@Injectable()
export class InventoryClient {
  private readonly baseUrl: string;
  private readonly secret: string;

  constructor(config: ConfigService) {
    this.baseUrl = config
      .getOrThrow<string>('INVENTORY_SERVICE_URL')
      .replace(/\/+$/, '');
    this.secret = config.getOrThrow<string>('INTERNAL_SERVICE_JWT_SECRET');
  }

  reserve(body: ReserveRequest, ctx: RequestContext): Promise<ReserveResult> {
    return this.post(
      '/internal/reservations',
      body,
      ctx,
      reserveResult,
      `order:${body.orderId}:v${body.orderVersion}`,
    );
  }

  preview(
    body: ReserveRequest,
    ctx: RequestContext,
  ): Promise<ReservationPreview> {
    return this.post(
      '/internal/reservations/preview',
      body,
      ctx,
      previewResult,
    );
  }

  release(
    orderId: string,
    ctx: RequestContext,
  ): Promise<{ outcome: 'RELEASED' }> {
    return this.post(
      '/internal/reservations/release',
      { orderId },
      ctx,
      z.object({ outcome: z.literal('RELEASED') }),
    );
  }

  active(
    orderId: string,
    ctx: RequestContext,
  ): Promise<{ reservationGroupId: string | null }> {
    return this.post(
      `/internal/reservations/${encodeURIComponent(orderId)}/active`,
      undefined,
      ctx,
      z.object({ reservationGroupId: z.string().uuid().nullable() }),
      undefined,
      'GET',
    );
  }

  private async post<T>(
    path: string,
    body: ReserveRequest | { orderId: string } | undefined,
    ctx: RequestContext,
    schema: z.ZodType<T>,
    idempotencyKey?: string,
    method = 'POST',
  ): Promise<T> {
    const token = signInternalServiceToken({
      secret: this.secret,
      service: ServiceId.ORDER_SERVICE,
      audience: ServiceId.INVENTORY_SERVICE,
      tenantId: ctx.tenantId,
      ttlSeconds: INTERNAL_TOKEN_TTL_SECONDS,
    });
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          [INTERNAL_SERVICE_TOKEN_HEADER]: token,
          'x-correlation-id': ctx.correlationId,
          ...(idempotencyKey && { 'idempotency-key': idempotencyKey }),
        },
        ...(method === 'POST' && { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(INVENTORY_REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw OrderErrors.upstreamUnavailable(ServiceId.INVENTORY_SERVICE);
    }
    if (response.status >= 500)
      throw OrderErrors.upstreamUnavailable(ServiceId.INVENTORY_SERVICE);
    if (!response.ok)
      throw OrderErrors.upstreamRejected(
        ServiceId.INVENTORY_SERVICE,
        response.status,
      );
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw OrderErrors.upstreamUnavailable(ServiceId.INVENTORY_SERVICE);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success)
      throw OrderErrors.upstreamUnavailable(ServiceId.INVENTORY_SERVICE);
    return parsed.data;
  }
}
