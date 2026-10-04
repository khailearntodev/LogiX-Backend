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

@Module({
  imports: [AuthModule],
  controllers: [
    WarehousesController,
    ProductsController,
    VehiclesController,
    CustomersController,
    CustomerAddressesController,
  ],
  providers: [
    WarehouseService,
    ProductService,
    VehicleService,
    CustomerService,
    CustomerAddressService,
  ],
  exports: [
    WarehouseService,
    ProductService,
    VehicleService,
    CustomerService,
  ],
})
export class MasterDataModule {}
