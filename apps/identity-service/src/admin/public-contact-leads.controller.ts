import { Body, Controller, HttpCode, HttpStatus, Inject, Post } from '@nestjs/common';
import { CreateContactLeadDto } from './dto/create-contact-lead.dto.js';
import { AdminContactLeadsService } from './services/admin-contact-leads.service.js';

@Controller('auth/contact-leads')
export class PublicContactLeadsController {
  constructor(
    @Inject(AdminContactLeadsService)
    private readonly contactLeads: AdminContactLeadsService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateContactLeadDto) {
    return this.contactLeads.createContactLead(dto);
  }
}

