import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Put,
  Param,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
  Headers,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard.js';
import { PermissionsGuard } from '../../auth/guards/permissions.guard.js';
import { RequirePermissions } from '../../auth/decorators/permissions.decorator.js';
import { CurrentUser } from '../../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface.js';
import { RolesService } from '../services/roles.service.js';
import { CreateRoleDto } from '../dto/create-role.dto.js';
import { UpdateRoleDto } from '../dto/update-role.dto.js';
import { AssignRolePermissionsDto } from '../dto/assign-role-permissions.dto.js';
import { AssignMemberRolesDto } from '../dto/assign-member-roles.dto.js';

@Controller('iam')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  @Get('permissions')
  @RequirePermissions('iam:role:read')
  async getAllPermissions() {
    return this.rolesService.getAllPermissions();
  }

  @Get('roles')
  @RequirePermissions('iam:role:read')
  async getRoles(
    @CurrentUser() user: AuthenticatedUser,
    @Headers('x-tenant-id') headerTenantId?: string,
  ) {
    const tenantId = user.isSuperAdmin && headerTenantId ? headerTenantId : user.tenantId;
    return this.rolesService.getRoles(tenantId);
  }

  @Post('roles')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('iam:role:manage')
  async createRole(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateRoleDto,
    @Headers('x-tenant-id') headerTenantId?: string,
  ) {
    const tenantId = user.isSuperAdmin && headerTenantId ? headerTenantId : user.tenantId;
    return this.rolesService.createRole(tenantId, dto, user.id);
  }

  @Get('roles/:id')
  @RequirePermissions('iam:role:read')
  async getRoleById(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Headers('x-tenant-id') headerTenantId?: string,
  ) {
    const tenantId = user.isSuperAdmin && headerTenantId ? headerTenantId : user.tenantId;
    return this.rolesService.getRoleById(tenantId, id);
  }

  @Patch('roles/:id')
  @RequirePermissions('iam:role:manage')
  async updateRole(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateRoleDto,
    @Headers('x-tenant-id') headerTenantId?: string,
  ) {
    const tenantId = user.isSuperAdmin && headerTenantId ? headerTenantId : user.tenantId;
    return this.rolesService.updateRole(tenantId, id, dto);
  }

  @Delete('roles/:id')
  @RequirePermissions('iam:role:manage')
  async deleteRole(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Headers('x-tenant-id') headerTenantId?: string,
  ) {
    const tenantId = user.isSuperAdmin && headerTenantId ? headerTenantId : user.tenantId;
    return this.rolesService.deleteRole(tenantId, id);
  }

  @Put('roles/:id/permissions')
  @RequirePermissions('iam:role:manage')
  async updateRolePermissions(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: AssignRolePermissionsDto,
    @Headers('x-tenant-id') headerTenantId?: string,
  ) {
    const tenantId = user.isSuperAdmin && headerTenantId ? headerTenantId : user.tenantId;
    return this.rolesService.updateRolePermissions(tenantId, id, dto.permissionIds, user.id);
  }

  @Get('members')
  @RequirePermissions('iam:member:read')
  async getMembers(
    @CurrentUser() user: AuthenticatedUser,
    @Headers('x-tenant-id') headerTenantId?: string,
  ) {
    const tenantId = user.isSuperAdmin && headerTenantId ? headerTenantId : user.tenantId;
    return this.rolesService.getMembers(tenantId);
  }

  @Post('members/:userId/roles')
  @RequirePermissions('iam:member:assign-role')
  async assignMemberRoles(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId') targetUserId: string,
    @Body() dto: AssignMemberRolesDto,
    @Headers('x-tenant-id') headerTenantId?: string,
  ) {
    const tenantId = user.isSuperAdmin && headerTenantId ? headerTenantId : user.tenantId;
    return this.rolesService.assignMemberRoles(tenantId, targetUserId, dto.roleIds, user.id);
  }
}
