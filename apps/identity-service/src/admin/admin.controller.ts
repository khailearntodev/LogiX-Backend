import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { SuperAdminGuard } from '../auth/guards/super-admin.guard.js';
import {
  SendContactLeadEmailDto,
  UpdateContactLeadStatusDto,
} from './dto/contact-lead-action.dto.js';
import {
  ListContactLeadsQueryDto,
  ListOrganizationsQueryDto,
  ListUsersQueryDto,
} from './dto/list-admin-query.dto.js';
import { AdminContactLeadsService } from './services/admin-contact-leads.service.js';
import { AdminQueryService } from './services/admin-query.service.js';

@Controller('admin')
@UseGuards(JwtAuthGuard, SuperAdminGuard)
export class AdminController {
  constructor(
    @Inject(AdminQueryService) private readonly queries: AdminQueryService,
    @Inject(AdminContactLeadsService)
    private readonly contactLeads: AdminContactLeadsService,
  ) {}

  @Get('organizations')
  listOrganizations(@Query() query: ListOrganizationsQueryDto) {
    return this.queries.listOrganizations(query);
  }

  @Get('users')
  listUsers(@Query() query: ListUsersQueryDto) {
    return this.queries.listUsers(query);
  }

  @Get('contact-leads')
  listContactLeads(@Query() query: ListContactLeadsQueryDto) {
    return this.contactLeads.listContactLeads(query);
  }

  @Patch('contact-leads/:id/status')
  updateContactLeadStatus(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateContactLeadStatusDto,
    @CurrentUser('id') actorUserId: string,
  ) {
    return this.contactLeads.updateContactLeadStatus(id, dto, actorUserId);
  }

  @Post('contact-leads/:id/send-email')
  @HttpCode(HttpStatus.OK)
  sendContactLeadEmail(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: SendContactLeadEmailDto,
    @CurrentUser('id') actorUserId: string,
  ) {
    return this.contactLeads.sendEmailToContactLead(id, dto, actorUserId);
  }
}
