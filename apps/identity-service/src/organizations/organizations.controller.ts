import {
  Controller,
  Post,
  Get,
  Patch,
  Param,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { OrganizationService } from './services/organization.service.js';
import { CreateOrganizationDto } from './dto/create-organization.dto.js';
import { UpdateOrganizationDto } from './dto/update-organization.dto.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface.js';

@Controller('auth/organizations')
@UseGuards(JwtAuthGuard)
export class OrganizationsController {
  constructor(private readonly organizationService: OrganizationService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createOrganization(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateOrganizationDto,
  ) {
    return this.organizationService.createOrganization(user.id, dto);
  }

  @Get(':tenantId')
  async getOrganization(
    @CurrentUser() user: AuthenticatedUser,
    @Param('tenantId') tenantId: string,
  ) {
    return this.organizationService.getOrganization(user.id, tenantId);
  }

  @Patch(':tenantId')
  async updateOrganization(
    @CurrentUser() user: AuthenticatedUser,
    @Param('tenantId') tenantId: string,
    @Body() dto: UpdateOrganizationDto,
  ) {
    return this.organizationService.updateOrganization(user.id, tenantId, dto);
  }

  @Post(':tenantId/set-default')
  @HttpCode(HttpStatus.OK)
  async setDefaultTenant(
    @CurrentUser() user: AuthenticatedUser,
    @Param('tenantId') tenantId: string,
  ) {
    return this.organizationService.setDefaultTenant(user.id, tenantId);
  }
}
