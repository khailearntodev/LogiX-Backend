import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { SuperAdminGuard } from '../auth/guards/super-admin.guard.js';
import { AdminController } from './admin.controller.js';
import { AdminQueryService } from './services/admin-query.service.js';

@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [AdminController],
  providers: [AdminQueryService, SuperAdminGuard],
})
export class AdminModule {}
