import { Controller, Get, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { AllowInternalCallers, InternalCaller, InternalServiceGuard, type InternalServiceTokenClaims } from '@logix/auth';
import { ServiceId } from '@logix/common';
import { WarehouseService } from './warehouses/services/warehouse.service.js';
import { VehicleService } from './vehicles/services/vehicle.service.js';

@Controller('internal/trip-resources')
@UseGuards(InternalServiceGuard)
@AllowInternalCallers(ServiceId.TRANSPORT_SERVICE)
export class InternalTripResourcesController {
  constructor(private readonly warehouses: WarehouseService, private readonly vehicles: VehicleService) {}

  @Get('warehouses/:id')
  warehouse(@InternalCaller() caller: InternalServiceTokenClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.warehouses.getById(caller.tenantId, id);
  }

  @Get('vehicles/:id')
  vehicle(@InternalCaller() caller: InternalServiceTokenClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.vehicles.getById(caller.tenantId, id);
  }
}
