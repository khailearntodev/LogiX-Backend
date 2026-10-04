import { Module, forwardRef } from '@nestjs/common';
import { RolesService } from './services/roles.service.js';
import { RolesController } from './controllers/roles.controller.js';
import { InvitationsService } from './services/invitations.service.js';
import { InvitationsController } from './controllers/invitations.controller.js';
import { AuthModule } from '../auth/auth.module.js';

@Module({
  imports: [forwardRef(() => AuthModule)],
  controllers: [RolesController, InvitationsController],
  providers: [RolesService, InvitationsService],
  exports: [RolesService, InvitationsService],
})
export class IamModule {}
