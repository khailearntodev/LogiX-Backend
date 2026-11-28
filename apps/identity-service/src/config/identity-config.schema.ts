import {
  databaseConfigSchema,
  kafkaConfigSchema,
  outboxConfigSchema,
} from '@logix/config';
import { z } from 'zod';

export const identityConfigSchema = databaseConfigSchema
  .merge(kafkaConfigSchema)
  .merge(outboxConfigSchema)
  .extend({
    INTERNAL_SERVICE_JWT_SECRET: z.string().min(32),
    FRONTEND_URL: z.string().url(),
    KAFKA_IDENTITY_TOPIC: z.string().min(1),
  });

export type IdentityConfig = z.infer<typeof identityConfigSchema>;
