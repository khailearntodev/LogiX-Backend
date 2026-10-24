import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { SuperAdminGuard } from '../auth/guards/super-admin.guard.js';
import {
  ListOrganizationsQueryDto,
  ListUsersQueryDto,
} from './dto/list-admin-query.dto.js';
import { AdminQueryService } from './services/admin-query.service.js';

@Controller('admin')
@UseGuards(JwtAuthGuard, SuperAdminGuard)
export class AdminController {
  constructor(
    @Inject(AdminQueryService) private readonly queries: AdminQueryService,
  ) {}

  @Get('organizations')
  listOrganizations(@Query() query: ListOrganizationsQueryDto) {
    return this.queries.listOrganizations(query);
  }

  @Get('users')
  listUsers(@Query() query: ListUsersQueryDto) {
    return this.queries.listUsers(query);
  }
}
