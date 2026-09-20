import { Controller, Get, UseGuards } from '@nestjs/common';
import { OrganizationService } from './services/organization.service.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface.js';

@Controller('auth/tenants')
@UseGuards(JwtAuthGuard)
export class TenantsController {
  constructor(private readonly organizationService: OrganizationService) {}

  @Get()
  async getTenants(@CurrentUser() user: AuthenticatedUser) {
    return this.organizationService.getTenants(user.id);
  }
}
