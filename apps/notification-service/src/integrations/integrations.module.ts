import { Module } from '@nestjs/common';
import { IdentityRecipientClient } from './identity-recipient.client.js';

@Module({
  providers: [IdentityRecipientClient],
  exports: [IdentityRecipientClient],
})
export class IntegrationsModule {}
