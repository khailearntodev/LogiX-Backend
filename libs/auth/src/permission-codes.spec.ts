import { describe, expect, it } from 'vitest';
import {
  MASTER_DATA_DRIVER_PERMISSIONS,
  TRANSPORT_PERMISSIONS,
} from './permission-codes.js';

describe('shared transport permission codes', () => {
  it('exports the contract codes used by Identity and transport services', () => {
    expect(TRANSPORT_PERMISSIONS).toEqual({
      TRIP_READ: 'transport:trip:read',
      TRIP_CREATE: 'transport:trip:create',
      TRIP_UPDATE: 'transport:trip:update',
      TRIP_DISPATCH: 'transport:trip:dispatch',
      ROUTE_READ: 'transport:route:read',
      ROUTE_OPTIMIZE: 'transport:route:optimize',
      ROUTE_APPROVE: 'transport:route:approve',
      DRIVER_READ: 'transport:driver:read',
      DRIVER_UPDATE: 'transport:driver:update',
    });
    expect(MASTER_DATA_DRIVER_PERMISSIONS).toEqual({
      READ: 'master-data:driver:read',
      MANAGE: 'master-data:driver:manage',
    });
  });
});
