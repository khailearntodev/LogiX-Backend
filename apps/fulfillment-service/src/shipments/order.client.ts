import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  INTERNAL_SERVICE_TOKEN_HEADER,
  signInternalServiceToken,
} from '@logix/auth';
import { ServiceId } from '@logix/common';
import {
  shipmentLineSchema,
  batchDispatchGrantDecisionSchema,
  type BatchDispatchGrantRequest,
  type AuthorizeOrderDispatchRequest,
} from '@logix/messaging';
import { z } from 'zod';
import { ORDER_HTTP_TIMEOUT_MS, ShipmentErrors } from './shipment.domain.js';
import type { ShipmentContext } from './shipment.persistence.js';

const snapshotSchema = z.object({
  id: z.string().uuid(),
  status: z.string(),
  version: z.number().int().positive().safe(),
  reservationGroupId: z.string().uuid().nullable(),
  cancellationRequestedAt: z.string().nullable(),
  lines: z.array(
    shipmentLineSchema
      .omit({ orderLineId: true })
      .extend({ id: z.string().uuid() }),
  ),
});
const grantSchema = z.object({
  requestId: z.string().uuid(),
  shipmentId: z.string().uuid(),
  orderId: z.string().uuid(),
  reservationGroupId: z.string().uuid(),
  orderVersion: z.number().int().positive().safe(),
  actorId: z.string().uuid(),
  grantedAt: z.string().datetime(),
  correlationId: z.string().uuid(),
});
export class OrderRequestRejected extends Error {
  constructor(readonly status: number) {
    super(`Order rejected request (${status})`);
  }
}
@Injectable()
export class OrderClient {
  private readonly url: string;
  private readonly secret: string;
  constructor(config: ConfigService) {
    this.url = config
      .getOrThrow<string>('ORDER_SERVICE_URL')
      .replace(/\/+$/, '');
    this.secret = config.getOrThrow<string>('INTERNAL_SERVICE_JWT_SECRET');
  }
  snapshot(orderId: string, ctx: ShipmentContext) {
    return this.request(
      `/internal/orders/${orderId}/fulfillment-snapshot`,
      ctx,
      snapshotSchema,
    );
  }
  authorize(
    orderId: string,
    body: AuthorizeOrderDispatchRequest,
    ctx: ShipmentContext,
  ) {
    return this.request(
      `/internal/orders/${orderId}/authorize-dispatch`,
      ctx,
      grantSchema,
      body,
    );
  }
  authorizeBatch(body: BatchDispatchGrantRequest) {
    return this.request('/internal/orders/authorize-dispatch-batch', {
      tenantId: body.tenantId, actorId: body.actorId, correlationId: body.requestId,
    }, batchDispatchGrantDecisionSchema, body);
  }
  private async request<T>(
    path: string,
    ctx: ShipmentContext,
    schema: z.ZodType<T>,
    body?: AuthorizeOrderDispatchRequest | BatchDispatchGrantRequest,
  ): Promise<T> {
    const token = signInternalServiceToken({
      secret: this.secret,
      service: ServiceId.FULFILLMENT_SERVICE,
      audience: ServiceId.ORDER_SERVICE,
      tenantId: ctx.tenantId,
      ttlSeconds: 60,
    });
    let response: Response;
    try {
      response = await fetch(`${this.url}${path}`, {
        method: body ? 'POST' : 'GET',
        signal: AbortSignal.timeout(ORDER_HTTP_TIMEOUT_MS),
        headers: {
          'content-type': 'application/json',
          [INTERNAL_SERVICE_TOKEN_HEADER]: token,
          'x-correlation-id': ctx.correlationId,
        },
        ...(body && { body: JSON.stringify(body) }),
      });
    } catch {
      throw ShipmentErrors.unavailable();
    }
    if (response.status >= 500) throw ShipmentErrors.unavailable();
    if (!response.ok) {
      if (body && response.status === 409)
        throw new OrderRequestRejected(response.status);
      throw ShipmentErrors.upstream(response.status);
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw ShipmentErrors.unavailable();
    }
    const result = schema.safeParse(json);
    if (!result.success) throw ShipmentErrors.unavailable();
    return result.data;
  }
}
