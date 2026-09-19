import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { OrganizationService } from './services/organization.service.js';
import { OrganizationsController } from './organizations.controller.js';
import { TenantsController } from './tenants.controller.js';

@Module({
  imports: [AuthModule],
  controllers: [OrganizationsController, TenantsController],
  providers: [OrganizationService],
  exports: [OrganizationService],
})
export class OrganizationsModule {}
