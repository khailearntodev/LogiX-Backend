import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { WarehousesController } from './warehouses/warehouses.controller.js';
import { WarehouseService } from './warehouses/services/warehouse.service.js';
import { ProductsController } from './products/products.controller.js';
import { ProductService } from './products/services/product.service.js';
import { VehiclesController } from './vehicles/vehicles.controller.js';
import { VehicleService } from './vehicles/services/vehicle.service.js';
import { CustomersController } from './customers/customers.controller.js';
import { CustomerAddressesController } from './customers/customer-addresses.controller.js';
import { CustomerService } from './customers/services/customer.service.js';
import { CustomerAddressService } from './customers/services/customer-address.service.js';
import { DriversController } from './drivers/drivers.controller.js';
import { DriverService } from './drivers/driver.service.js';
import { IdentityDriverClient } from './drivers/identity-driver.client.js';
import {
  PermissionsGuard,
  InternalServiceGuard,
  INTERNAL_SERVICE_AUTH_OPTIONS,
} from '@logix/auth';
import { ConfigService } from '@nestjs/config';
import { ServiceId } from '@logix/common';
import { DriverLinkService } from './drivers/driver-link.service.js';
import { TransportDriverClient } from './drivers/transport-driver.client.js';
import { InternalDriverLinksController } from './drivers/internal-driver-links.controller.js';

@Module({
  imports: [AuthModule],
  controllers: [
    DriversController,
    InternalDriverLinksController,
    WarehousesController,
    ProductsController,
    VehiclesController,
    CustomersController,
    CustomerAddressesController,
  ],
  providers: [
    DriverService,
    DriverLinkService,
    TransportDriverClient,
    InternalServiceGuard,
    {
      provide: INTERNAL_SERVICE_AUTH_OPTIONS,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('INTERNAL_SERVICE_JWT_SECRET'),
        serviceName: ServiceId.MASTER_DATA_SERVICE,
      }),
    },
    IdentityDriverClient,
    PermissionsGuard,
    WarehouseService,
    ProductService,
    VehicleService,
    CustomerService,
    CustomerAddressService,
  ],
  exports: [WarehouseService, ProductService, VehicleService, CustomerService],
})
export class MasterDataModule {}
