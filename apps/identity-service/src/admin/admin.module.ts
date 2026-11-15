import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { MailModule } from '../mail/mail.module.js';
import { SuperAdminGuard } from '../auth/guards/super-admin.guard.js';
import { AdminController } from './admin.controller.js';
import { PublicContactLeadsController } from './public-contact-leads.controller.js';
import { AdminContactLeadsService } from './services/admin-contact-leads.service.js';
import { AdminQueryService } from './services/admin-query.service.js';

@Module({
  imports: [AuthModule, DatabaseModule, MailModule],
  controllers: [AdminController, PublicContactLeadsController],
  providers: [AdminQueryService, AdminContactLeadsService, SuperAdminGuard],
})
export class AdminModule {}
