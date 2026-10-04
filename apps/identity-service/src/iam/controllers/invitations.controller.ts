import {
  Controller,
  Get,
  Post,
  Delete,
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
import { InvitationsService } from '../services/invitations.service.js';
import { CreateInvitationDto } from '../dto/create-invitation.dto.js';

@Controller('iam/invitations')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class InvitationsController {
  constructor(private readonly invitationsService: InvitationsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('iam:member:invite', 'iam:member:assign-role')
  async createInvitation(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateInvitationDto,
    @Headers('x-tenant-id') headerTenantId?: string,
  ) {
    const tenantId = user.isSuperAdmin && headerTenantId ? headerTenantId : user.tenantId;
    return this.invitationsService.createInvitation(
      tenantId,
      user.id,
      Boolean(user.isSuperAdmin),
      user.role,
      dto,
    );
  }

  @Get()
  @RequirePermissions('iam:member:read')
  async getInvitations(
    @CurrentUser() user: AuthenticatedUser,
    @Headers('x-tenant-id') headerTenantId?: string,
  ) {
    const tenantId = user.isSuperAdmin && headerTenantId ? headerTenantId : user.tenantId;
    return this.invitationsService.getInvitations(tenantId);
  }

  @Post(':id/resend')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('iam:member:invite')
  async resendInvitation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Headers('x-tenant-id') headerTenantId?: string,
  ) {
    const tenantId = user.isSuperAdmin && headerTenantId ? headerTenantId : user.tenantId;
    return this.invitationsService.resendInvitation(tenantId, id);
  }

  @Post(':id/revoke')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('iam:member:invite')
  async revokeInvitation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Headers('x-tenant-id') headerTenantId?: string,
  ) {
    const tenantId = user.isSuperAdmin && headerTenantId ? headerTenantId : user.tenantId;
    return this.invitationsService.revokeInvitation(tenantId, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('iam:member:invite')
  async deleteInvitation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Headers('x-tenant-id') headerTenantId?: string,
  ) {
    const tenantId = user.isSuperAdmin && headerTenantId ? headerTenantId : user.tenantId;
    return this.invitationsService.deleteInvitation(tenantId, id);
  }
}
