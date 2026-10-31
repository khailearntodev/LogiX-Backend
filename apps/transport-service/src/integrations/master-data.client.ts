import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { signInternalServiceToken } from '@logix/auth';
import { ServiceId } from '@logix/common';
import { BusinessRuleViolationError, EntityNotFoundError } from '@logix/errors';
import { TripConflictError } from '../trips/trip-conflict.error.js';
import { DownstreamServiceError } from './downstream-error.js';
import { z } from 'zod';

interface WarehouseView {
  id: string;
  code: string;
  name: string;
  addressLine: string;
  ward: string | null;
  district: string | null;
  province: string;
  postalCode: string | null;
  latitude: string | null;
  longitude: string | null;
  status: string;
  version: number;
}

interface VehicleView {
  id: string;
  code: string;
  licensePlate: string;
  capacityWeight: string;
  capacityVolume: string;
  status: string;
  version: number;
}

interface DriverView {
  id: string;
  tenantId: string;
  userId: string;
  status: string;
  version: number;
}

@Injectable()
export class MasterDataClient {
  constructor(private readonly config: ConfigService) {}

  async driverForTrip(tenantId: string, driverId: string) {
    const token = signInternalServiceToken({
      service: ServiceId.TRANSPORT_SERVICE,
      audience: ServiceId.MASTER_DATA_SERVICE,
      tenantId,
      secret: this.config.getOrThrow<string>('INTERNAL_SERVICE_JWT_SECRET'),
      ttlSeconds: 60,
    });
    const raw = await this.request<unknown>(`/internal/drivers/${driverId}/trip-eligibility`, {
      headers: { 'x-internal-service-token': token },
    });
    const result = z.object({
      id: z.string().uuid(), tenantId: z.string().uuid(), userId: z.string().uuid(),
      code: z.string().min(1), displayName: z.string().min(1), phone: z.string().nullable(),
      licenseNumber: z.string().min(1), licenseExpiry: z.string(),
      status: z.literal('ACTIVE'), version: z.number().int().positive().safe(),
    }).safeParse(raw);
    if (!result.success || result.data.id !== driverId || result.data.tenantId !== tenantId)
      throw new DownstreamServiceError('Master Data', 502);
    return result.data;
  }

  async warehouse(
    tenantId: string,
    warehouseId: string,
    authorization?: string,
  ): Promise<WarehouseView> {
    const warehouse = await this.get<WarehouseView>(
      authorization ? `/warehouses/${warehouseId}` : `/internal/trip-resources/warehouses/${warehouseId}`,
      authorization ?? this.internalAuthorization(tenantId),
    );
    if (warehouse.id !== warehouseId) {
      throw new DownstreamServiceError('Master Data', 502);
    }
    this.assertSafeVersion(warehouse.version);
    if (warehouse.status !== 'ACTIVE') {
      throw new BusinessRuleViolationError('WAREHOUSE_MUST_BE_ACTIVE', { warehouseId });
    }
    void tenantId;
    return warehouse;
  }

  async vehicle(
    vehicleId: string,
    authorization: string | undefined,
    tenantId?: string,
  ): Promise<VehicleView> {
    const vehicle = await this.get<VehicleView>(
      authorization ? `/vehicles/${vehicleId}` : `/internal/trip-resources/vehicles/${vehicleId}`,
      authorization ?? this.internalAuthorization(tenantId!),
    );
    if (vehicle.id !== vehicleId) {
      throw new DownstreamServiceError('Master Data', 502);
    }
    this.assertSafeVersion(vehicle.version);
    if (vehicle.status !== 'ACTIVE') {
      throw new BusinessRuleViolationError('VEHICLE_MUST_BE_ACTIVE', { vehicleId });
    }
    return vehicle;
  }

  async lockDriver(
    tenantId: string,
    driverId: string,
    authorization: string,
  ): Promise<{ driverId: string; userId: string; version: number }> {
    const driver = await this.get<DriverView>(`/drivers/${driverId}`, authorization);
    if (driver.id !== driverId || driver.tenantId !== tenantId) {
      throw new EntityNotFoundError('Driver', driverId);
    }
    if (driver.status !== 'ACTIVE') {
      throw new BusinessRuleViolationError('DRIVER_MUST_BE_ACTIVE', { driverId });
    }
    if (!Number.isSafeInteger(driver.version) || driver.version < 1) {
      throw new DownstreamServiceError('Master Data', 502);
    }

    const secret = this.config.getOrThrow<string>('INTERNAL_SERVICE_JWT_SECRET');
    const token = signInternalServiceToken({
      service: ServiceId.TRANSPORT_SERVICE,
      audience: ServiceId.MASTER_DATA_SERVICE,
      tenantId,
      secret,
      ttlSeconds: 60,
    });
    const binding = await this.request<{ driverId: string; userId: string; version: number }>(
      `/internal/drivers/${driverId}/link-lock`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-service-token': token,
        },
        body: JSON.stringify({
          version: driver.version,
          expectedUserId: driver.userId,
        }),
      },
    );
    if (
      binding.driverId !== driverId ||
      binding.userId !== driver.userId ||
      binding.version !== driver.version
    ) {
      throw new DownstreamServiceError('Master Data', 502);
    }
    return binding;
  }

  private internalAuthorization(tenantId: string): Record<string, string> {
    if (!tenantId) throw new Error('Internal resource read requires tenant');
    return { 'x-internal-service-token': signInternalServiceToken({
      service: ServiceId.TRANSPORT_SERVICE, audience: ServiceId.MASTER_DATA_SERVICE,
      tenantId, secret: this.config.getOrThrow<string>('INTERNAL_SERVICE_JWT_SECRET'), ttlSeconds: 60,
    }) };
  }

  private get<T>(path: string, authorization: string | Record<string, string>): Promise<T> {
    return this.request<T>(path, {
      headers: typeof authorization === 'string' ? { authorization } : authorization,
    });
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const base = this.config.getOrThrow<string>('MASTER_DATA_SERVICE_URL');
    let response: Response;
    try {
      response = await fetch(new URL(`/api/v1${path}`, base), {
        ...init,
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw new DownstreamServiceError('Master Data', null);
    }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status === 404) throw new EntityNotFoundError('Master Data reference', path);
      if (response.status === 409) throw new TripConflictError('MASTER_DATA_REFERENCE_CHANGED');
      throw new DownstreamServiceError('Master Data', response.status);
    }
    return body as T;
  }

  private assertSafeVersion(value: number): void {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new DownstreamServiceError('Master Data', 502);
    }
  }
}
