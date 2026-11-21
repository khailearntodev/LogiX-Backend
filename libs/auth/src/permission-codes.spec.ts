import { describe, expect, it } from 'vitest';
import {
  FORECAST_PERMISSIONS,
  FULFILLMENT_PERMISSIONS,
  IAM_PERMISSIONS,
  INVENTORY_PERMISSIONS,
  MASTER_DATA_DRIVER_PERMISSIONS,
  MASTER_DATA_PERMISSIONS,
  MEMBER_RESTRICTED_PERMISSIONS,
  ORDER_PERMISSIONS,
  REPORT_PERMISSIONS,
  TRANSPORT_PERMISSIONS,
} from './permission-codes.js';

describe('shared permission codes (@logix/auth)', () => {
  it('exports the contract codes used by Identity and domain services', () => {
    expect(FULFILLMENT_PERMISSIONS).toEqual({
      SHIPMENT_READ: 'fulfillment:shipment:read',
      SHIPMENT_UPDATE: 'fulfillment:shipment:update',
      SHIPMENT_DISPATCH: 'fulfillment:shipment:dispatch',
      SHIPMENT_COMPLETE: 'fulfillment:shipment:complete',
    });

    expect(INVENTORY_PERMISSIONS).toEqual({
      WAREHOUSE_READ: 'inventory:warehouse:read',
      WAREHOUSE_CREATE: 'inventory:warehouse:create',
      WAREHOUSE_UPDATE: 'inventory:warehouse:update',
      WAREHOUSE_DELETE: 'inventory:warehouse:delete',
      STOCK_READ: 'inventory:stock:read',
      STOCK_ADJUST: 'inventory:stock:adjust',
    });

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
      VEHICLE_READ: 'transport:vehicle:read',
      VEHICLE_MANAGE: 'transport:vehicle:manage',
    });

    expect(MASTER_DATA_DRIVER_PERMISSIONS).toEqual({
      READ: 'master-data:driver:read',
      MANAGE: 'master-data:driver:manage',
    });

    expect(MASTER_DATA_PERMISSIONS).toEqual({
      DRIVER_READ: 'master-data:driver:read',
      DRIVER_MANAGE: 'master-data:driver:manage',
      CUSTOMER_READ: 'master-data:customer:read',
      CUSTOMER_MANAGE: 'master-data:customer:manage',
      PRODUCT_READ: 'master-data:product:read',
      PRODUCT_MANAGE: 'master-data:product:manage',
    });

    expect(ORDER_PERMISSIONS).toEqual({
      SALES_ORDER_READ: 'order:sales-order:read',
      SALES_ORDER_CREATE: 'order:sales-order:create',
      SALES_ORDER_UPDATE: 'order:sales-order:update',
      SALES_ORDER_APPROVE: 'order:sales-order:approve',
      SALES_ORDER_CANCEL: 'order:sales-order:cancel',
    });

    expect(IAM_PERMISSIONS).toEqual({
      ROLE_READ: 'iam:role:read',
      ROLE_MANAGE: 'iam:role:manage',
      MEMBER_READ: 'iam:member:read',
      MEMBER_INVITE: 'iam:member:invite',
      MEMBER_ASSIGN_ROLE: 'iam:member:assign-role',
      MEMBER_REMOVE: 'iam:member:remove',
      ORGANIZATION_MANAGE: 'iam:organization:manage',
      AI_INSTRUCTIONS_MANAGE: 'iam:ai-instructions:manage',
    });

    expect(FORECAST_PERMISSIONS).toEqual({
      READ: 'forecast:read',
      RUN: 'forecast:run',
    });

    expect(REPORT_PERMISSIONS).toEqual({
      ANALYTICS_READ: 'report:analytics:read',
      EXPORT_EXECUTE: 'report:export:execute',
    });

    expect(MEMBER_RESTRICTED_PERMISSIONS).toEqual([
      'master-data:driver:read',
      'transport:driver:read',
    ]);
  });
});
