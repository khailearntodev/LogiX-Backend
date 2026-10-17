import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CORRELATION_ID_HEADER,
  MASTER_DATA_REQUEST_TIMEOUT_MS,
  MASTER_DATA_SERVICE_NAME,
} from '../domain/order-constants.js';
import { OrderErrors } from '../domain/order-errors.js';
import type {
  MasterDataCustomer,
  MasterDataCustomerAddress,
  MasterDataProduct,
  MasterDataRequestContext,
  MasterDataWarehouse,
} from './master-data.types.js';

const API_PREFIX = '/api/v1';
const HTTP_NOT_FOUND = 404;
const HTTP_SERVER_ERROR_MIN = 500;

/**
 * Thin HTTP client for master-data-service. Upstream failures are translated
 * into order domain errors so callers never leak transport details:
 * - 404 → `null` (caller decides which field was missing),
 * - 5xx / network failure / timeout / malformed body → 503 UPSTREAM_UNAVAILABLE,
 * - any other non-2xx (including 401/403) → 502 UPSTREAM_REJECTED.
 */
@Injectable()
export class MasterDataClient {
  private readonly baseUrl: string;

  constructor(config: ConfigService) {
    const serviceUrl = config.getOrThrow<string>('MASTER_DATA_SERVICE_URL');
    this.baseUrl = `${serviceUrl.replace(/\/+$/, '')}${API_PREFIX}`;
  }

  getCustomer(
    id: string,
    ctx: MasterDataRequestContext,
  ): Promise<MasterDataCustomer | null> {
    return this.get<MasterDataCustomer>(
      `/customers/${encodeURIComponent(id)}`,
      ctx,
    );
  }

  listCustomerAddresses(
    customerId: string,
    ctx: MasterDataRequestContext,
  ): Promise<MasterDataCustomerAddress[] | null> {
    return this.get<MasterDataCustomerAddress[]>(
      `/customers/${encodeURIComponent(customerId)}/addresses`,
      ctx,
    );
  }

  getWarehouse(
    id: string,
    ctx: MasterDataRequestContext,
  ): Promise<MasterDataWarehouse | null> {
    return this.get<MasterDataWarehouse>(
      `/warehouses/${encodeURIComponent(id)}`,
      ctx,
    );
  }

  getProduct(
    id: string,
    ctx: MasterDataRequestContext,
  ): Promise<MasterDataProduct | null> {
    return this.get<MasterDataProduct>(
      `/products/${encodeURIComponent(id)}`,
      ctx,
    );
  }

  private async get<T>(
    path: string,
    ctx: MasterDataRequestContext,
  ): Promise<T | null> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: ctx.authorization,
          [CORRELATION_ID_HEADER]: ctx.correlationId,
        },
        signal: AbortSignal.timeout(MASTER_DATA_REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw OrderErrors.upstreamUnavailable(MASTER_DATA_SERVICE_NAME);
    }

    if (response.status === HTTP_NOT_FOUND) {
      return null;
    }
    if (response.status >= HTTP_SERVER_ERROR_MIN) {
      throw OrderErrors.upstreamUnavailable(MASTER_DATA_SERVICE_NAME);
    }
    if (!response.ok) {
      throw OrderErrors.upstreamRejected(
        MASTER_DATA_SERVICE_NAME,
        response.status,
      );
    }

    try {
      return (await response.json()) as T;
    } catch {
      throw OrderErrors.upstreamUnavailable(MASTER_DATA_SERVICE_NAME);
    }
  }
}
