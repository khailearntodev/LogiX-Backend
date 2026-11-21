import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { Reflector } from '@nestjs/core';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import {
  FORECAST_PERMISSIONS,
  INVENTORY_PERMISSIONS,
  MASTER_DATA_PERMISSIONS,
  ORDER_PERMISSIONS,
  PERMISSIONS_KEY,
  PermissionsGuard,
  TRANSPORT_PERMISSIONS,
} from '@logix/auth';
import { WarehousesController } from './warehouses/warehouses.controller.js';
import { VehiclesController } from './vehicles/vehicles.controller.js';
import { ProductsController } from './products/products.controller.js';
import { CustomersController } from './customers/customers.controller.js';
import { CustomerAddressesController } from './customers/customer-addresses.controller.js';

function createMockContext(
  handler: (...args: any[]) => unknown,
  controllerClass: Function,
  user: Record<string, unknown>,
): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => controllerClass,
    switchToHttp: () => ({
      getRequest: () => ({ user }),
    }),
  } as unknown as ExecutionContext;
}

describe('Master Data controllers RBAC enforcement', () => {
  const reflector = new Reflector();
  const guard = new PermissionsGuard(reflector);

  it('requires inventory:warehouse or cross-domain picker read permissions on WarehousesController', () => {
    expect(
      Reflect.getMetadata(PERMISSIONS_KEY, WarehousesController.prototype.list),
    ).toEqual([
      INVENTORY_PERMISSIONS.WAREHOUSE_READ,
      INVENTORY_PERMISSIONS.WAREHOUSE_CREATE,
      INVENTORY_PERMISSIONS.WAREHOUSE_UPDATE,
      INVENTORY_PERMISSIONS.STOCK_READ,
      ORDER_PERMISSIONS.SALES_ORDER_READ,
      TRANSPORT_PERMISSIONS.TRIP_READ,
      FORECAST_PERMISSIONS.READ,
    ]);
    expect(
      Reflect.getMetadata(PERMISSIONS_KEY, WarehousesController.prototype.create),
    ).toEqual([INVENTORY_PERMISSIONS.WAREHOUSE_CREATE]);
    expect(
      Reflect.getMetadata(PERMISSIONS_KEY, WarehousesController.prototype.update),
    ).toEqual([INVENTORY_PERMISSIONS.WAREHOUSE_UPDATE]);

    const orderStaffUser = {
      id: 'u1',
      tenantId: 't1',
      role: 'MEMBER',
      permissions: [ORDER_PERMISSIONS.SALES_ORDER_READ],
    };
    const driverOnlyUser = {
      id: 'u1b',
      tenantId: 't1',
      role: 'MEMBER',
      permissions: [TRANSPORT_PERMISSIONS.DRIVER_READ],
    };

    expect(
      guard.canActivate(
        createMockContext(WarehousesController.prototype.list, WarehousesController, orderStaffUser),
      ),
    ).toBe(true);
    expect(() =>
      guard.canActivate(
        createMockContext(
          WarehousesController.prototype.create,
          WarehousesController,
          orderStaffUser,
        ),
      ),
    ).toThrow(ForbiddenException);
    expect(() =>
      guard.canActivate(
        createMockContext(WarehousesController.prototype.list, WarehousesController, driverOnlyUser),
      ),
    ).toThrow(ForbiddenException);
  });

  it('requires transport:vehicle permissions on VehiclesController', () => {
    expect(
      Reflect.getMetadata(PERMISSIONS_KEY, VehiclesController.prototype.list),
    ).toEqual([
      TRANSPORT_PERMISSIONS.VEHICLE_READ,
      TRANSPORT_PERMISSIONS.VEHICLE_MANAGE,
      TRANSPORT_PERMISSIONS.TRIP_READ,
    ]);
    expect(
      Reflect.getMetadata(PERMISSIONS_KEY, VehiclesController.prototype.create),
    ).toEqual([TRANSPORT_PERMISSIONS.VEHICLE_MANAGE]);

    const dispatcherUser = {
      id: 'u2',
      tenantId: 't1',
      role: 'MEMBER',
      permissions: [TRANSPORT_PERMISSIONS.TRIP_READ],
    };
    const driverOnlyUser = {
      id: 'u3',
      tenantId: 't1',
      role: 'MEMBER',
      permissions: [TRANSPORT_PERMISSIONS.DRIVER_READ],
    };

    expect(
      guard.canActivate(
        createMockContext(VehiclesController.prototype.list, VehiclesController, dispatcherUser),
      ),
    ).toBe(true);
    expect(() =>
      guard.canActivate(
        createMockContext(VehiclesController.prototype.create, VehiclesController, dispatcherUser),
      ),
    ).toThrow(ForbiddenException);
    expect(() =>
      guard.canActivate(
        createMockContext(VehiclesController.prototype.list, VehiclesController, driverOnlyUser),
      ),
    ).toThrow(ForbiddenException);
  });

  it('requires master-data:product permissions on ProductsController', () => {
    expect(
      Reflect.getMetadata(PERMISSIONS_KEY, ProductsController.prototype.list),
    ).toEqual([
      MASTER_DATA_PERMISSIONS.PRODUCT_READ,
      MASTER_DATA_PERMISSIONS.PRODUCT_MANAGE,
      ORDER_PERMISSIONS.SALES_ORDER_READ,
      INVENTORY_PERMISSIONS.STOCK_READ,
    ]);
    expect(
      Reflect.getMetadata(PERMISSIONS_KEY, ProductsController.prototype.update),
    ).toEqual([MASTER_DATA_PERMISSIONS.PRODUCT_MANAGE]);

    const orderStaffUser = {
      id: 'u4',
      tenantId: 't1',
      role: 'MEMBER',
      permissions: [ORDER_PERMISSIONS.SALES_ORDER_READ],
    };
    expect(
      guard.canActivate(
        createMockContext(ProductsController.prototype.list, ProductsController, orderStaffUser),
      ),
    ).toBe(true);
    expect(() =>
      guard.canActivate(
        createMockContext(ProductsController.prototype.update, ProductsController, orderStaffUser),
      ),
    ).toThrow(ForbiddenException);
  });

  it('requires master-data:customer permissions on CustomersController and CustomerAddressesController', () => {
    expect(
      Reflect.getMetadata(PERMISSIONS_KEY, CustomersController.prototype.list),
    ).toEqual([
      MASTER_DATA_PERMISSIONS.CUSTOMER_READ,
      MASTER_DATA_PERMISSIONS.CUSTOMER_MANAGE,
      ORDER_PERMISSIONS.SALES_ORDER_READ,
    ]);
    expect(
      Reflect.getMetadata(PERMISSIONS_KEY, CustomersController.prototype.disable),
    ).toEqual([MASTER_DATA_PERMISSIONS.CUSTOMER_MANAGE]);
    expect(
      Reflect.getMetadata(PERMISSIONS_KEY, CustomerAddressesController.prototype.create),
    ).toEqual([MASTER_DATA_PERMISSIONS.CUSTOMER_MANAGE]);

    const customerManager = {
      id: 'u5',
      tenantId: 't1',
      role: 'MEMBER',
      permissions: [MASTER_DATA_PERMISSIONS.CUSTOMER_MANAGE],
    };
    const unauthorizedUser = {
      id: 'u6',
      tenantId: 't1',
      role: 'MEMBER',
      permissions: [],
    };

    expect(
      guard.canActivate(
        createMockContext(
          CustomerAddressesController.prototype.create,
          CustomerAddressesController,
          customerManager,
        ),
      ),
    ).toBe(true);
    expect(() =>
      guard.canActivate(
        createMockContext(
          CustomersController.prototype.list,
          CustomersController,
          unauthorizedUser,
        ),
      ),
    ).toThrow(ForbiddenException);
  });
});
